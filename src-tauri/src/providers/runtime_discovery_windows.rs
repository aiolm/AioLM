//! Windows listener discovery without PowerShell or WMI startup.
//! Read only socket ownership, current-user SID, executable and creation time.
//! Existing processes are never adopted, stopped or inspected for credentials.
use super::*;
use std::collections::BTreeMap;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::PathBuf;
use windows_sys::Win32::Foundation::{FILETIME, HANDLE};
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

fn listener(line: &str) -> Option<(u32, LocalEndpoint)> {
    let columns = line.split_whitespace().collect::<Vec<_>>();
    if columns.len() != 5
        || !columns[0].eq_ignore_ascii_case("TCP")
        || !columns[3].eq_ignore_ascii_case("LISTENING")
    {
        return None;
    }
    let (host, port) = columns[1].rsplit_once(':')?;
    let address = host.trim_matches(['[', ']']).parse().ok()?;
    let endpoint = local_endpoint(address, port.parse().ok()?)?;
    let pid = columns[4].parse::<u32>().ok().filter(|pid| *pid != 0)?;
    Some((pid, endpoint))
}

pub(super) fn discover(report: &mut DiscoveryReport, cancel: &AtomicBool) -> Result<(), String> {
    let Some(system) = std::env::var_os("SystemRoot") else {
        report
            .warnings
            .push("The system listener inventory is unavailable.".into());
        return Ok(());
    };
    let program = PathBuf::from(system).join("System32/netstat.exe");
    let bytes = match system_inventory(&program, &["-ano"], cancel) {
        Ok(bytes) => bytes,
        Err(message) => {
            cancelled(cancel)?;
            report.warnings.push(message);
            return Ok(());
        }
    };
    let Some(current_user) = user_token(unsafe { GetCurrentProcess() }) else {
        report
            .warnings
            .push("The current Windows user identity is unavailable.".into());
        return Ok(());
    };
    let mut listeners = BTreeMap::<u32, BTreeSet<LocalEndpoint>>::new();
    for (index, line) in String::from_utf8_lossy(&bytes).lines().enumerate() {
        cancelled(cancel)?;
        if index >= MAX_ENTRIES {
            report.truncated = true;
            break;
        }
        if let Some((pid, endpoint)) = listener(line) {
            listeners.entry(pid).or_default().insert(endpoint);
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

    #[test]
    fn listener_rows_keep_ipv4_ipv6_and_exclude_udp_remote_and_nonlisteners() {
        let row = "TCP 127.0.0.1:43121 0.0.0.0:0 LISTENING 42";
        let (pid, endpoint) = listener(row).unwrap();
        assert_eq!(pid, 42);
        assert_eq!(endpoint.host, "127.0.0.1");
        assert_eq!(endpoint.port, 43121);
        assert_eq!(
            listener(&row.replace("127.0.0.1", "[::1]")).unwrap().1.host,
            "::1"
        );
        assert_eq!(
            listener(&row.replace("127.0.0.1", "0.0.0.0"))
                .unwrap()
                .1
                .host,
            "127.0.0.1"
        );
        assert!(listener(&row.replace("127.0.0.1", "192.0.2.1")).is_none());
        assert!(listener(&row.replace("LISTENING", "ESTABLISHED")).is_none());
        assert!(listener(&row.replace("TCP", "UDP")).is_none());
        assert!(listener(&row.replace(" 42", " 0")).is_none());
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
