//! Strict read-only closure proof for the fixture's IPv4 loopback listener.
//! A refused TCP connection can spend seconds in Windows retransmission logic;
//! the kernel LISTEN tables answer the actual post-join question directly.

#[cfg(any(windows, test))]
use std::time::{Duration, Instant};

const MAX_TABLE_BYTES: usize = 4 * 1024 * 1024;
const HEADER_BYTES: usize = 4;

#[derive(Clone, Copy, Debug)]
pub enum Family {
    V4,
    V6,
}

impl Family {
    fn row_bytes(self) -> usize {
        match self {
            Self::V4 => 24,
            Self::V6 => 56,
        }
    }
}

fn word(bytes: &[u8], offset: usize) -> u32 {
    u32::from_ne_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("validated DWORD span"),
    )
}

pub fn table_has_loopback_listener(
    bytes: &[u8],
    family: Family,
    port: u16,
) -> Result<bool, String> {
    if port == 0 || bytes.len() < HEADER_BYTES || bytes.len() > MAX_TABLE_BYTES {
        return Err("fixture listener table has an invalid size or target port".into());
    }
    let count = word(bytes, 0) as usize;
    let required = count
        .checked_mul(family.row_bytes())
        .and_then(|size| size.checked_add(HEADER_BYTES))
        .ok_or("fixture listener table row count overflow")?;
    if required > bytes.len() {
        return Err("fixture listener table has incomplete rows".into());
    }
    let mut found = false;
    // No PID filter or row truncation: another process rebinding this exact
    // endpoint must prevent a closure proof, and every row must be validated.
    for row in bytes[HEADER_BYTES..required].chunks_exact(family.row_bytes()) {
        let (state, network_port, address_matches) = match family {
            Family::V4 => {
                let address = word(row, 4).to_ne_bytes();
                (
                    word(row, 0),
                    word(row, 8),
                    address == [127, 0, 0, 1] || address == [0, 0, 0, 0],
                )
            }
            Family::V6 => {
                let address = &row[..16];
                let mapped =
                    address[..10].iter().all(|byte| *byte == 0) && address[10..12] == [255, 255];
                let mapped_loopback =
                    mapped && (address[12..] == [127, 0, 0, 1] || address[12..] == [0, 0, 0, 0]);
                // A wildcard may be dual-stack. The table does not expose
                // IPV6_V6ONLY, so ambiguity must fail closed, not prove absence.
                (
                    word(row, 48),
                    word(row, 20),
                    address.iter().all(|byte| *byte == 0) || mapped_loopback,
                )
            }
        };
        if !matches!(state, 1..=12 | 100) {
            return Err("fixture listener table has an invalid TCP state".into());
        }
        let row_port = u16::from_be(network_port as u16);
        if state == 2 && row_port == 0 {
            return Err("fixture LISTEN row has no valid local port".into());
        }
        if state == 2 && row_port == port && address_matches {
            found = true;
        }
    }
    Ok(found)
}

#[cfg(any(windows, test))]
#[derive(Debug)]
pub struct ClosureProof {
    pub elapsed: Duration,
    pub snapshots: u32,
    pub api_queries: u32,
}

#[cfg(any(windows, test))]
struct Snapshot {
    listening: bool,
    api_queries: u32,
}

#[cfg(any(windows, test))]
fn wait_with_snapshot(
    limit: Duration,
    mut query: impl FnMut() -> Result<Snapshot, String>,
) -> Result<ClosureProof, String> {
    let started = Instant::now();
    let deadline = started
        .checked_add(limit)
        .ok_or("fixture listener deadline overflow")?;
    let mut snapshots = 0;
    let mut api_queries = 0;
    loop {
        if Instant::now() >= deadline {
            return Err(format!(
                "foreign listener remains after checked stop (bound {limit:?})"
            ));
        }
        let snapshot = query()?;
        snapshots += 1;
        api_queries += snapshot.api_queries;
        if Instant::now() >= deadline {
            return Err(format!(
                "foreign listener closure query exceeded its {limit:?} bound"
            ));
        }
        if !snapshot.listening {
            return Ok(ClosureProof {
                elapsed: started.elapsed(),
                snapshots,
                api_queries,
            });
        }
        std::thread::sleep(
            Duration::from_millis(10).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID, MIB_TCPROW_OWNER_PID,
        MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};

    // Keep the portable decoder tied to the native DWORD-only SDK records.
    const _: () = {
        assert!(std::mem::offset_of!(MIB_TCPTABLE_OWNER_PID, table) == HEADER_BYTES);
        assert!(std::mem::size_of::<MIB_TCPROW_OWNER_PID>() == 24);
        assert!(std::mem::offset_of!(MIB_TCPROW_OWNER_PID, dwState) == 0);
        assert!(std::mem::offset_of!(MIB_TCPROW_OWNER_PID, dwLocalAddr) == 4);
        assert!(std::mem::offset_of!(MIB_TCPROW_OWNER_PID, dwLocalPort) == 8);
        assert!(std::mem::offset_of!(MIB_TCP6TABLE_OWNER_PID, table) == HEADER_BYTES);
        assert!(std::mem::size_of::<MIB_TCP6ROW_OWNER_PID>() == 56);
        assert!(std::mem::offset_of!(MIB_TCP6ROW_OWNER_PID, ucLocalAddr) == 0);
        assert!(std::mem::offset_of!(MIB_TCP6ROW_OWNER_PID, dwLocalPort) == 20);
        assert!(std::mem::offset_of!(MIB_TCP6ROW_OWNER_PID, dwState) == 48);
    };

    fn table(family: Family, deadline: Instant, calls: &mut u32) -> Result<Vec<u8>, String> {
        let address_family = u32::from(match family {
            Family::V4 => AF_INET,
            Family::V6 => AF_INET6,
        });
        let mut size = 0;
        if Instant::now() >= deadline {
            return Err("fixture listener query deadline elapsed".into());
        }
        *calls += 1;
        let status = unsafe {
            GetExtendedTcpTable(
                std::ptr::null_mut(),
                &mut size,
                0,
                address_family,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if status != ERROR_SUCCESS && status != ERROR_INSUFFICIENT_BUFFER {
            return Err(format!(
                "fixture {family:?} listener table query failed: Win32 {status}"
            ));
        }
        for _ in 0..3 {
            if Instant::now() >= deadline {
                return Err("fixture listener query deadline elapsed".into());
            }
            if !(HEADER_BYTES..=MAX_TABLE_BYTES).contains(&(size as usize)) {
                return Err("fixture listener table exceeds its complete-buffer bounds".into());
            }
            // The API writes native DWORD records; guarantee their alignment
            // rather than depending on incidental Vec<u8> allocator alignment.
            let mut storage = vec![0_u32; (size as usize).div_ceil(4)];
            let capacity_bytes = storage.len() * 4;
            size = capacity_bytes as u32;
            *calls += 1;
            let status = unsafe {
                GetExtendedTcpTable(
                    storage.as_mut_ptr().cast(),
                    &mut size,
                    0,
                    address_family,
                    TCP_TABLE_OWNER_PID_LISTENER,
                    0,
                )
            };
            if status == ERROR_INSUFFICIENT_BUFFER {
                continue;
            }
            if status != ERROR_SUCCESS {
                return Err(format!(
                    "fixture {family:?} listener table read failed: Win32 {status}"
                ));
            }
            if size as usize > capacity_bytes || size < HEADER_BYTES as u32 {
                return Err("fixture listener table returned an incomplete buffer".into());
            }
            // The checked size is within the allocated DWORD array. Copy into
            // portable bytes before the backing native records are dropped.
            return Ok(unsafe {
                std::slice::from_raw_parts(storage.as_ptr().cast::<u8>(), size as usize)
            }
            .to_vec());
        }
        Err("fixture listener table kept growing during bounded reads".into())
    }

    fn snapshot(port: u16, deadline: Instant) -> Result<Snapshot, String> {
        let mut api_queries = 0;
        let ipv4 = table(Family::V4, deadline, &mut api_queries)?;
        let ipv6 = table(Family::V6, deadline, &mut api_queries)?;
        let ipv4 = table_has_loopback_listener(&ipv4, Family::V4, port)?;
        let ipv6 = table_has_loopback_listener(&ipv6, Family::V6, port)?;
        Ok(Snapshot {
            listening: ipv4 || ipv6,
            api_queries,
        })
    }

    pub fn wait_loopback_listener_closed(
        port: u16,
        limit: Duration,
    ) -> Result<ClosureProof, String> {
        let deadline = Instant::now()
            .checked_add(limit)
            .ok_or("fixture listener deadline overflow")?;
        wait_with_snapshot(limit, || snapshot(port, deadline))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::net::TcpListener;

        #[test]
        fn native_table_detects_live_closed_and_rebound_listener() {
            let first = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let port = first.local_addr().unwrap().port();
            assert!(
                snapshot(port, Instant::now() + Duration::from_secs(10))
                    .unwrap()
                    .listening
            );
            assert!(wait_loopback_listener_closed(port, Duration::from_millis(25)).is_err());
            drop(first);
            let proof = wait_loopback_listener_closed(port, Duration::from_secs(10)).unwrap();
            assert!(proof.api_queries >= 4 && proof.snapshots >= 1);
            let rebound = TcpListener::bind(("127.0.0.1", port)).unwrap();
            assert!(
                snapshot(port, Instant::now() + Duration::from_secs(10))
                    .unwrap()
                    .listening
            );
            drop(rebound);
            wait_loopback_listener_closed(port, Duration::from_secs(10)).unwrap();
        }

        #[test]
        fn native_table_detects_wildcard_listener() {
            let listener = TcpListener::bind(("0.0.0.0", 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            assert!(
                snapshot(port, Instant::now() + Duration::from_secs(10))
                    .unwrap()
                    .listening
            );
            drop(listener);
            wait_loopback_listener_closed(port, Duration::from_secs(10)).unwrap();
        }
    }
}

#[cfg(windows)]
pub use native::wait_loopback_listener_closed;

#[cfg(test)]
mod tests {
    use super::*;

    fn table(family: Family, rows: &[(u32, [u8; 16], u16, u32)]) -> Vec<u8> {
        let mut bytes = (rows.len() as u32).to_ne_bytes().to_vec();
        for (state, address, port, pid) in rows {
            let mut row = vec![0; family.row_bytes()];
            let (state_offset, port_offset) = match family {
                Family::V4 => {
                    row[4..8].copy_from_slice(&address[..4]);
                    (0, 8)
                }
                Family::V6 => {
                    row[..16].copy_from_slice(address);
                    (48, 20)
                }
            };
            row[state_offset..state_offset + 4].copy_from_slice(&state.to_ne_bytes());
            row[port_offset..port_offset + 4]
                .copy_from_slice(&u32::from(port.to_be()).to_ne_bytes());
            let end = row.len();
            row[end - 4..].copy_from_slice(&pid.to_ne_bytes());
            bytes.extend(row);
        }
        bytes
    }

    fn v4(address: [u8; 4]) -> [u8; 16] {
        let mut all = [0; 16];
        all[..4].copy_from_slice(&address);
        all
    }

    #[test]
    fn ipv4_matches_exact_address_port_and_any_owner() {
        for address in [[127, 0, 0, 1], [0, 0, 0, 0]] {
            for pid in [0, 1, 9999] {
                assert!(table_has_loopback_listener(
                    &table(Family::V4, &[(2, v4(address), 12345, pid)]),
                    Family::V4,
                    12345
                )
                .unwrap());
            }
        }
        for (address, port) in [
            ([127, 0, 0, 2], 12345),
            ([10, 0, 0, 1], 12345),
            ([127, 0, 0, 1], 12346),
        ] {
            assert!(!table_has_loopback_listener(
                &table(Family::V4, &[(2, v4(address), port, 1)]),
                Family::V4,
                12345
            )
            .unwrap());
        }
    }

    #[test]
    fn ipv6_wildcard_and_mapped_ipv4_are_conservatively_visible() {
        let mut mapped = [0; 16];
        mapped[10..12].fill(255);
        mapped[12..].copy_from_slice(&[127, 0, 0, 1]);
        let mut mapped_any = [0; 16];
        mapped_any[10..12].fill(255);
        for address in [[0; 16], mapped, mapped_any] {
            assert!(table_has_loopback_listener(
                &table(Family::V6, &[(2, address, 12345, 77)]),
                Family::V6,
                12345
            )
            .unwrap());
        }
        let mut loopback = [0; 16];
        loopback[15] = 1;
        let mut other = mapped;
        other[15] = 2;
        for address in [loopback, other] {
            assert!(!table_has_loopback_listener(
                &table(Family::V6, &[(2, address, 12345, 77)]),
                Family::V6,
                12345
            )
            .unwrap());
        }
    }

    #[test]
    fn time_wait_does_not_masquerade_as_a_listener() {
        let bytes = table(Family::V4, &[(11, v4([127, 0, 0, 1]), 12345, 7)]);
        assert!(!table_has_loopback_listener(&bytes, Family::V4, 12345).unwrap());
    }

    #[test]
    fn malformed_or_truncated_tables_never_prove_absence() {
        for family in [Family::V4, Family::V6] {
            for bytes in [
                vec![],
                vec![0; 3],
                1_u32.to_ne_bytes().to_vec(),
                u32::MAX.to_ne_bytes().to_vec(),
                vec![0; MAX_TABLE_BYTES + 1],
            ] {
                assert!(table_has_loopback_listener(&bytes, family, 12345).is_err());
            }
            let mut bytes = table(family, &[(2, [0; 16], 12345, 1)]);
            bytes.pop();
            assert!(table_has_loopback_listener(&bytes, family, 12345).is_err());
            assert!(table_has_loopback_listener(
                &table(family, &[(0, [0; 16], 12345, 1)]),
                family,
                12345
            )
            .is_err());
            assert!(table_has_loopback_listener(
                &table(family, &[(2, [0; 16], 0, 1)]),
                family,
                12345
            )
            .is_err());
            assert!(!table_has_loopback_listener(&0_u32.to_ne_bytes(), family, 12345).unwrap());
        }
    }

    #[test]
    fn a_match_does_not_skip_validation_of_later_rows() {
        let bytes = table(
            Family::V4,
            &[
                (2, v4([127, 0, 0, 1]), 12345, 1),
                (999, v4([10, 0, 0, 1]), 12346, 2),
            ],
        );
        assert!(table_has_loopback_listener(&bytes, Family::V4, 12345).is_err());
    }

    #[test]
    fn query_failure_is_fatal_and_snapshot_removal_is_bounded() {
        let error = wait_with_snapshot(Duration::from_secs(1), || {
            Err("injected native API failure".into())
        })
        .unwrap_err();
        assert_eq!(error, "injected native API failure");
        let mut count = 0;
        let proof = wait_with_snapshot(Duration::from_secs(1), || {
            count += 1;
            Ok(Snapshot {
                listening: count == 1,
                api_queries: 4,
            })
        })
        .unwrap();
        assert_eq!(proof.snapshots, 2);
        assert_eq!(proof.api_queries, 8);
        assert!(proof.elapsed >= Duration::from_millis(10));
        assert!(
            wait_with_snapshot(Duration::from_millis(15), || Ok(Snapshot {
                listening: true,
                api_queries: 4
            }))
            .is_err()
        );
    }
}
