//! The descendant receipt can precede its parent's launch-resource PID bind.
//! Keep the original startup deadline and wait only for that explicit state.

use serde_json::Value;
use std::time::{Duration, Instant};

pub struct ResourceBinding {
    pub marker: Value,
    pub pid: u32,
    pub pending_observations: usize,
}

pub fn wait_for_resource_binding(
    expected_id: &str,
    listener: u32,
    owned_engines: &[u32],
    deadline: Instant,
    mut read_marker: impl FnMut() -> Result<Value, String>,
    mut retained_tree_running: impl FnMut() -> bool,
) -> Result<ResourceBinding, String> {
    let mut pending_observations = 0;
    loop {
        if pending_observations > 0 && Instant::now() >= deadline {
            return Err("resource marker binding exceeded the startup deadline".into());
        }
        let marker = read_marker()?;
        if marker["version"] != 1 || marker["id"].as_str() != Some(expected_id) {
            return Err("resource marker version or UUID differs".into());
        }
        let pid = marker.get("pid").ok_or("resource marker PID is missing")?;
        if !pid.is_null() {
            let pid = pid
                .as_u64()
                .and_then(|pid| u32::try_from(pid).ok())
                .ok_or("resource marker PID is invalid")?;
            if pid == 0 || pid == listener || !owned_engines.contains(&pid) {
                return Err("resource marker PID is not the retained launcher".into());
            }
            if !retained_tree_running() {
                return Err("owned native tree ended before resource binding".into());
            }
            if Instant::now() >= deadline {
                return Err("resource marker binding exceeded the startup deadline".into());
            }
            return Ok(ResourceBinding {
                marker,
                pid,
                pending_observations,
            });
        }
        if !retained_tree_running() {
            return Err("owned native tree ended before resource binding".into());
        }
        if Instant::now() >= deadline {
            return Err("resource marker binding exceeded the startup deadline".into());
        }
        pending_observations += 1;
        std::thread::sleep(
            Duration::from_millis(10).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::VecDeque;

    const ID: &str = "synthetic-resource";
    const ROOT: u32 = 101;
    const LISTENER: u32 = 202;

    fn marker(pid: Value) -> Value {
        json!({"version": 1, "id": ID, "pid": pid})
    }

    #[test]
    fn a_receipt_before_parent_binding_waits_for_the_exact_retained_launcher() {
        let mut observations = VecDeque::from([marker(Value::Null), marker(json!(ROOT))]);
        let mut ownership_checks = 0;
        let bound = wait_for_resource_binding(
            ID,
            LISTENER,
            &[ROOT, LISTENER],
            Instant::now() + Duration::from_secs(1),
            || {
                Ok(observations
                    .pop_front()
                    .expect("bounded marker observations"))
            },
            || {
                ownership_checks += 1;
                true
            },
        )
        .unwrap();
        assert_eq!(bound.pid, ROOT);
        assert_eq!(bound.marker, marker(json!(ROOT)));
        assert_eq!(bound.pending_observations, 1);
        assert_eq!(ownership_checks, 2);
        assert!(observations.is_empty());
    }

    #[test]
    fn pending_binding_uses_the_existing_expired_startup_deadline() {
        let mut reads = 0;
        let result = wait_for_resource_binding(
            ID,
            LISTENER,
            &[ROOT, LISTENER],
            Instant::now(),
            || {
                reads += 1;
                Ok(marker(Value::Null))
            },
            || true,
        );
        assert!(matches!(result, Err(error) if error.contains("startup deadline")));
        assert_eq!(reads, 1);
    }

    #[test]
    fn a_late_binding_cannot_extend_the_original_startup_deadline() {
        let mut reads = 0;
        let result = wait_for_resource_binding(
            ID,
            LISTENER,
            &[ROOT, LISTENER],
            Instant::now() + Duration::from_millis(1),
            || {
                reads += 1;
                Ok(if reads == 1 {
                    marker(Value::Null)
                } else {
                    marker(json!(ROOT))
                })
            },
            || true,
        );
        assert!(matches!(result, Err(error) if error.contains("startup deadline")));
        assert_eq!(
            reads, 1,
            "no second marker read after the original deadline"
        );
        let result = wait_for_resource_binding(
            ID,
            LISTENER,
            &[ROOT, LISTENER],
            Instant::now() + Duration::from_millis(1),
            || Ok(marker(json!(ROOT))),
            || {
                std::thread::sleep(Duration::from_millis(2));
                true
            },
        );
        assert!(matches!(result, Err(error) if error.contains("startup deadline")));
    }

    #[test]
    fn malformed_identity_and_wrong_bound_pids_are_not_pending_states() {
        for value in [
            json!({"version": 2, "id": ID, "pid": null}),
            json!({"version": 1, "id": "another-resource", "pid": null}),
            json!({"version": 1, "id": ID}),
            marker(json!("101")),
            marker(json!(1.5)),
            marker(json!(0)),
            marker(json!(LISTENER)),
            marker(json!(303)),
            marker(json!(u64::from(u32::MAX) + 1)),
        ] {
            let mut reads = 0;
            let result = wait_for_resource_binding(
                ID,
                LISTENER,
                &[0, ROOT, LISTENER],
                Instant::now() + Duration::from_secs(1),
                || {
                    reads += 1;
                    Ok(value.clone())
                },
                || panic!("invalid identity must fail before waiting"),
            );
            assert!(result.is_err());
            assert_eq!(reads, 1);
        }
    }

    #[test]
    fn a_pending_marker_cannot_outlive_the_retained_native_tree() {
        let mut reads = 0;
        let result = wait_for_resource_binding(
            ID,
            LISTENER,
            &[ROOT, LISTENER],
            Instant::now() + Duration::from_secs(1),
            || {
                reads += 1;
                Ok(marker(Value::Null))
            },
            || false,
        );
        assert!(matches!(result, Err(error) if error.contains("native tree ended")));
        assert_eq!(reads, 1);
    }

    #[test]
    fn a_bound_marker_still_requires_the_retained_tree_to_be_running() {
        let mut observations = VecDeque::from([marker(Value::Null), marker(json!(ROOT))]);
        let mut ownership = VecDeque::from([true, false]);
        let result = wait_for_resource_binding(
            ID,
            LISTENER,
            &[ROOT, LISTENER],
            Instant::now() + Duration::from_secs(1),
            || {
                Ok(observations
                    .pop_front()
                    .expect("bounded marker observations"))
            },
            || {
                ownership
                    .pop_front()
                    .expect("bounded ownership observations")
            },
        );
        assert!(matches!(result, Err(error) if error.contains("native tree ended")));
        assert!(observations.is_empty());
        assert!(ownership.is_empty());
    }

    #[test]
    fn marker_read_or_parse_errors_fail_without_retry() {
        let mut reads = 0;
        let result = wait_for_resource_binding(
            ID,
            LISTENER,
            &[ROOT, LISTENER],
            Instant::now() + Duration::from_secs(1),
            || {
                reads += 1;
                serde_json::from_slice::<Value>(b"{incomplete").map_err(|error| error.to_string())
            },
            || panic!("invalid JSON must fail before waiting"),
        );
        assert!(result.is_err());
        assert_eq!(reads, 1);
    }
}
