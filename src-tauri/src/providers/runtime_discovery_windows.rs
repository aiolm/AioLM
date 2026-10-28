//! Native Windows listener discovery independent of localized command output.
//! Read only socket ownership, current-user SID, executable and creation time.
//! Existing processes are never adopted, stopped or inspected for credentials.
use super::*;
use std::collections::BTreeMap;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, FILETIME, HANDLE};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID, MIB_TCPROW_OWNER_PID,
    MIB_TCPTABLE_OWNER_PID, MIB_TCP_STATE_LISTEN, TCP_TABLE_OWNER_PID_LISTENER,
};
use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};
use windows_sys::Win32::Security::{
    EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

fn user_token(process: HANDLE) -> Option<Vec<u8>> {
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return None;
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut size = 0;
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            std::ptr::null_mut(),
            0,
            &mut size,
        );
    }
    if !(std::mem::size_of::<TOKEN_USER>() as u32..=16 * 1024).contains(&size) {
        return None;
    }
    let mut bytes = vec![0u8; size as usize];
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            bytes.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return None;
    }
    Some(bytes)
}

fn same_user(left: &[u8], right: &[u8]) -> bool {
    if left.len() < std::mem::size_of::<TOKEN_USER>()
        || right.len() < std::mem::size_of::<TOKEN_USER>()
    {
        return false;
    }
    // Win32 returned both TOKEN_USER records; their SID pointers stay valid
    // while the owning buffers remain alive. Do not assume Vec<u8> alignment.
    let left = unsafe { std::ptr::read_unaligned(left.as_ptr().cast::<TOKEN_USER>()) };
    let right = unsafe { std::ptr::read_unaligned(right.as_ptr().cast::<TOKEN_USER>()) };
    !left.User.Sid.is_null()
        && !right.User.Sid.is_null()
        && unsafe { EqualSid(left.User.Sid, right.User.Sid) } != 0
}

fn process_metadata(pid: u32, current_user: &[u8]) -> Option<(Option<String>, String)> {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return None;
    }
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    let owner = user_token(process.as_raw_handle())?;
    if !same_user(&owner, current_user) {
        return None;
    }
    let mut created: FILETIME = unsafe { std::mem::zeroed() };
    let mut exited: FILETIME = unsafe { std::mem::zeroed() };
    let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
    let mut user: FILETIME = unsafe { std::mem::zeroed() };
    if unsafe {
        GetProcessTimes(
            process.as_raw_handle(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return None;
    }
    let creation = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    if creation == 0 {
        return None;
    }
    let mut image = vec![0u16; 32768];
    let mut length = image.len() as u32;
    let path = if unsafe {
        QueryFullProcessImageNameW(process.as_raw_handle(), 0, image.as_mut_ptr(), &mut length)
    } != 0
    {
        String::from_utf16(&image[..length as usize])
            .ok()
            .filter(|path| Path::new(path).is_absolute())
    } else {
        None
    };
    Some((path, creation.to_string()))
}

const MAX_TABLE_BYTES: usize = 4 * 1024 * 1024;
const TABLE_ATTEMPTS: usize = 3;

fn tcp_table(ipv6: bool, cancel: &AtomicBool, truncated: &mut bool) -> Result<Vec<u8>, String> {
    let family = u32::from(if ipv6 { AF_INET6 } else { AF_INET });
    let mut size = 0;
    cancelled(cancel)?;
    let status = unsafe {
        GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            family,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if status != ERROR_INSUFFICIENT_BUFFER && status != ERROR_SUCCESS {
        return Err("The native Windows listener table is unavailable.".into());
    }
    for _ in 0..TABLE_ATTEMPTS {
        cancelled(cancel)?;
        if size as usize > MAX_TABLE_BYTES {
            *truncated = true;
            return Err("The native Windows listener table exceeds the discovery limit.".into());
        }
        if size < std::mem::size_of::<u32>() as u32 {
            return Err("The native Windows listener table is incomplete.".into());
        }
        let mut bytes = vec![0u8; size as usize];
        let status = unsafe {
            GetExtendedTcpTable(
                bytes.as_mut_ptr().cast(),
                &mut size,
                0,
                family,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        cancelled(cancel)?;
        if status == ERROR_INSUFFICIENT_BUFFER {
            continue;
        }
        if status != ERROR_SUCCESS || size as usize > bytes.len() {
            return Err("The native Windows listener table is unavailable or incomplete.".into());
        }
        bytes.truncate(size as usize);
        return Ok(bytes);
    }
    Err("The native Windows listener table changed repeatedly; find local servers again.".into())
}

fn listener(
    address: IpAddr,
    network_port: u32,
    state: u32,
    pid: u32,
) -> Option<(u32, LocalEndpoint)> {
    if pid == 0 || state != MIB_TCP_STATE_LISTEN as u32 {
        return None;
    }
    // Win32 stores a 16-bit network-order port in the low half of a DWORD.
    let port = u16::from_be(network_port as u16);
    Some((pid, local_endpoint(address, port)?))
}

fn table_listeners(
    bytes: &[u8],
    ipv6: bool,
    cancel: &AtomicBool,
) -> Result<(Vec<(u32, LocalEndpoint)>, bool), String> {
    cancelled(cancel)?;
    let (offset, row_size) = if ipv6 {
        (
            std::mem::offset_of!(MIB_TCP6TABLE_OWNER_PID, table),
            std::mem::size_of::<MIB_TCP6ROW_OWNER_PID>(),
        )
    } else {
        (
            std::mem::offset_of!(MIB_TCPTABLE_OWNER_PID, table),
            std::mem::size_of::<MIB_TCPROW_OWNER_PID>(),
        )
    };
    if bytes.len() < std::mem::size_of::<u32>()
        || bytes.len() < offset
        || bytes.len() > MAX_TABLE_BYTES
    {
        return Err("The native Windows listener table has an invalid size.".into());
    }
    let count = u32::from_ne_bytes(
        bytes[..4]
            .try_into()
            .map_err(|_| "The listener count is incomplete.")?,
    ) as usize;
    let required = count
        .checked_mul(row_size)
        .and_then(|length| length.checked_add(offset))
        .ok_or("The native Windows listener count exceeds its limits.")?;
    if required > bytes.len() {
        return Err("The native Windows listener table has incomplete rows.".into());
    }
    let mut listeners = Vec::new();
    for index in 0..count.min(MAX_ENTRIES) {
        cancelled(cancel)?;
        let start = offset + index * row_size;
        let row = &bytes[start..start + row_size];
        // Header/count bounds above prove that a complete native record is
        // present. These repr(C) records contain only unsigned integer data;
        // Vec<u8> and supplied test slices need not have record alignment.
        let found = if ipv6 {
            let row = unsafe {
                row.as_ptr()
                    .cast::<MIB_TCP6ROW_OWNER_PID>()
                    .read_unaligned()
            };
            listener(
                Ipv6Addr::from(row.ucLocalAddr).into(),
                row.dwLocalPort,
                row.dwState,
                row.dwOwningPid,
            )
        } else {
            let row = unsafe { row.as_ptr().cast::<MIB_TCPROW_OWNER_PID>().read_unaligned() };
            listener(
                Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes()).into(),
                row.dwLocalPort,
                row.dwState,
                row.dwOwningPid,
            )
        };
        if let Some(found) = found {
            listeners.push(found);
        }
    }
    Ok((listeners, count > MAX_ENTRIES))
}

pub(super) fn discover(report: &mut DiscoveryReport, cancel: &AtomicBool) -> Result<(), String> {
    cancelled(cancel)?;
    let Some(current_user) = user_token(unsafe { GetCurrentProcess() }) else {
        report
            .warnings
            .push("The current Windows user identity is unavailable.".into());
        return Ok(());
    };
    let mut listeners = BTreeMap::<u32, BTreeSet<LocalEndpoint>>::new();
    for ipv6 in [false, true] {
        let result = tcp_table(ipv6, cancel, &mut report.truncated)
            .and_then(|bytes| table_listeners(&bytes, ipv6, cancel));
        match result {
            Ok((rows, truncated)) => {
                report.truncated |= truncated;
                for (pid, endpoint) in rows {
                    listeners.entry(pid).or_default().insert(endpoint);
                }
            }
            Err(message) => {
                cancelled(cancel)?;
                report.warnings.push(message);
            }
        }
    }
    for (pid, endpoints) in listeners {
        cancelled(cancel)?;
        let Some((path, created)) = process_metadata(pid, &current_user) else {
            continue;
        };
        push(
            report,
            candidate(
                DiscoverySource::LocalProcess,
                path,
                None,
                endpoints.into_iter().collect(),
                EntrypointKind::Attached,
                Some((pid, created)),
                vec!["Owner and creation observed; protocol/model remain unverified.".into()],
            ),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn native_ipv4_table(rows: &[[u32; 6]]) -> Vec<u8> {
        let mut bytes = vec![0; std::mem::offset_of!(MIB_TCPTABLE_OWNER_PID, table)];
        bytes[..4].copy_from_slice(&(rows.len() as u32).to_ne_bytes());
        for row in rows {
            for word in row {
                bytes.extend(word.to_ne_bytes());
            }
        }
        bytes
    }

    #[test]
    fn native_tables_preserve_address_and_port_byte_order_without_state_text() {
        let port = 43121u16;
        let row = [
            MIB_TCP_STATE_LISTEN as u32,
            u32::from_ne_bytes([127, 0, 0, 1]),
            u32::from(port.to_be()),
            0,
            0,
            42,
        ];
        let table = native_ipv4_table(&[row]);
        // An unaligned slice must work just like the native byte buffer.
        let mut unaligned = vec![0x7f];
        unaligned.extend(table);
        let (rows, truncated) =
            table_listeners(&unaligned[1..], false, &AtomicBool::new(false)).unwrap();
        assert!(!truncated);
        assert_eq!(
            rows,
            [(
                42,
                LocalEndpoint {
                    host: "127.0.0.1".into(),
                    port
                }
            )]
        );
        let mut ipv6 = vec![0; std::mem::offset_of!(MIB_TCP6TABLE_OWNER_PID, table)];
        ipv6[..4].copy_from_slice(&1u32.to_ne_bytes());
        ipv6.extend(Ipv6Addr::LOCALHOST.octets());
        ipv6.extend(0u32.to_ne_bytes());
        ipv6.extend(u32::from(port.to_be()).to_ne_bytes());
        ipv6.extend([0u8; 16]);
        for word in [0, 0, MIB_TCP_STATE_LISTEN as u32, 43] {
            ipv6.extend(word.to_ne_bytes());
        }
        let (rows, truncated) = table_listeners(&ipv6, true, &AtomicBool::new(false)).unwrap();
        assert!(!truncated);
        assert_eq!(
            rows,
            [(
                43,
                LocalEndpoint {
                    host: "::1".into(),
                    port
                }
            )]
        );
    }

    #[test]
    fn numeric_listener_filter_keeps_only_live_local_owner_candidates() {
        let port = u32::from(12345u16.to_be());
        assert_eq!(
            listener(Ipv4Addr::UNSPECIFIED.into(), port, 2, 42)
                .unwrap()
                .1
                .host,
            "127.0.0.1"
        );
        assert_eq!(
            listener(Ipv6Addr::UNSPECIFIED.into(), port, 2, 42)
                .unwrap()
                .1
                .host,
            "::1"
        );
        assert!(listener(Ipv4Addr::new(192, 0, 2, 1).into(), port, 2, 42).is_none());
        assert!(listener(Ipv4Addr::LOCALHOST.into(), port, 5, 42).is_none());
        assert!(listener(Ipv4Addr::LOCALHOST.into(), port, 2, 0).is_none());
        assert!(listener(Ipv4Addr::LOCALHOST.into(), 0, 2, 42).is_none());
    }

    #[test]
    fn native_table_lengths_counts_limits_and_cancellation_are_checked() {
        let cancel = AtomicBool::new(false);
        assert!(table_listeners(&[0; 3], false, &cancel).is_err());
        let mut missing = native_ipv4_table(&[]);
        missing[..4].copy_from_slice(&u32::MAX.to_ne_bytes());
        assert!(table_listeners(&missing, false, &cancel).is_err());
        let row = [
            2,
            u32::from_ne_bytes([127, 0, 0, 1]),
            u32::from(12345u16.to_be()),
            0,
            0,
            42,
        ];
        let bytes = native_ipv4_table(&vec![row; MAX_ENTRIES + 1]);
        let (rows, truncated) = table_listeners(&bytes, false, &cancel).unwrap();
        assert_eq!(rows.len(), MAX_ENTRIES);
        assert!(truncated);
        let mut short = native_ipv4_table(&[row]);
        short.pop();
        assert!(table_listeners(&short, false, &cancel).is_err());
        assert!(table_listeners(&bytes, false, &AtomicBool::new(true))
            .unwrap_err()
            .contains("cancelled"));
    }

    #[test]
    fn native_inventory_finds_a_real_current_user_listener_without_adopting_it() {
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        let mut report = DiscoveryReport::default();
        discover(&mut report, &AtomicBool::new(false)).unwrap();
        assert!(report.candidates.iter().any(|candidate| candidate.pid
            == Some(std::process::id())
            && candidate
                .endpoints
                .iter()
                .any(|endpoint| endpoint.port == port)));
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_ok());
    }

    #[test]
    fn native_owner_metadata_is_stable_without_reading_arguments_or_environments() {
        let current = user_token(unsafe { GetCurrentProcess() }).unwrap();
        let first = process_metadata(std::process::id(), &current).unwrap();
        let second = process_metadata(std::process::id(), &current).unwrap();
        assert_eq!(first, second);
        assert!(!first.1.is_empty());
        assert!(first.0.is_some());
        assert!(same_user(&current, &current));
        assert!(!same_user(&[], &current));
    }
}
