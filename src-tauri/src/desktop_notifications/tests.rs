//! Real private-bus lifetime checks; these do not stand in for OS rendering.

use super::*;
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use tokio::io::{AsyncBufReadExt, BufReader};

struct Bus {
    process: tokio::process::Child,
    address: String,
}

impl Bus {
    async fn start() -> Self {
        let mut process = tokio::process::Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--nopidfile", "--print-address=1"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("private D-Bus daemon is required for the Linux lifetime regression");
        let mut output = BufReader::new(process.stdout.take().unwrap());
        let mut address = String::new();
        tokio::time::timeout(OPERATION_TIMEOUT, output.read_line(&mut address))
            .await
            .unwrap()
            .unwrap();
        assert!(address.starts_with("unix:"));
        Self {
            process,
            address: address.trim().to_string(),
        }
    }

    async fn connect(&self) -> zbus::Result<Connection> {
        zbus::connection::Builder::address(self.address.as_str())?
            .build()
            .await
    }

    async fn stop(mut self) {
        self.process.kill().await.unwrap();
        self.process.wait().await.unwrap();
    }
}

async fn has_owner(observer: &Connection, name: &str) -> bool {
    bounded(observer.call_method(
        Some("org.freedesktop.DBus"),
        "/org/freedesktop/DBus",
        Some("org.freedesktop.DBus"),
        "NameHasOwner",
        &(name,),
    ))
    .await
    .unwrap()
    .body()
    .deserialize()
    .unwrap()
}

#[tokio::test]
async fn completed_requests_retain_one_sender_until_service_shutdown() {
    let bus = Bus::start().await;
    let observer = bounded(bus.connect()).await.unwrap();
    let service = NotificationService::default();
    let mut sender = None;
    for _ in 0..2 {
        // End each request's temporary borrow/clone, as a Notify caller does.
        let name = {
            let mut cached = service.connection.try_lock().unwrap();
            let client = connection(&mut cached, bus.connect())
                .await
                .unwrap()
                .clone();
            bounded(client.call_method(
                Some("org.freedesktop.DBus"),
                "/org/freedesktop/DBus",
                Some("org.freedesktop.DBus"),
                "GetId",
                &(),
            ))
            .await
            .unwrap();
            client.unique_name().unwrap().to_string()
        };
        assert!(has_owner(&observer, &name).await);
        if let Some(previous) = &sender {
            assert_eq!(previous, &name);
        }
        sender = Some(name);
    }
    drop(service);
    let name = sender.unwrap();
    tokio::time::timeout(OPERATION_TIMEOUT, async {
        while has_owner(&observer, &name).await {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    bus.stop().await;
}

#[tokio::test]
async fn closed_sender_is_replaced_only_on_the_next_explicit_request() {
    let bus = Bus::start().await;
    let service = NotificationService::default();
    let mut cached = service.connection.try_lock().unwrap();
    let first = connection(&mut cached, bus.connect())
        .await
        .unwrap()
        .clone();
    let name = first.unique_name().unwrap().to_string();
    first.close().await.unwrap();
    assert!(cached.as_ref().unwrap().is_closed());
    let next = connection(&mut cached, bus.connect()).await.unwrap();
    assert_ne!(next.unique_name().unwrap().as_str(), name);
    assert!(!next.is_closed());
    // A busy component rejects immediately, without opening/queueing a client.
    assert!(service
        .submit("sample", "generic body")
        .await
        .unwrap_err()
        .contains("already"));
    drop(cached);
    drop(service);
    bus.stop().await;
}

#[tokio::test]
async fn acquisition_deadline_cancels_an_unresponsive_owned_peer() {
    // A real Unix peer accepts the socket but never authenticates. It is not
    // a notification-daemon substitute and cannot display an alert.
    let root = std::env::temp_dir().join(format!("aiolm-notification-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("bus");
    let listener = tokio::net::UnixListener::bind(&path).unwrap();
    let address = format!("unix:path={}", path.display());
    let connect = zbus::connection::Builder::address(address.as_str())
        .unwrap()
        .build();
    let attempt = bounded(connect);
    let error = {
        let hold_peer = async {
            let (_socket, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        };
        tokio::pin!(hold_peer);
        tokio::select! {
            result = attempt => result.unwrap_err(),
            () = &mut hold_peer => unreachable!(),
        }
    };
    assert!(error.contains("timed out"));
    drop(listener);
    std::fs::remove_dir_all(root).unwrap();
}

struct DelayedReply {
    calls: Arc<AtomicUsize>,
    finished: Arc<AtomicBool>,
    runtime: tokio::runtime::Handle,
}

// A private, generic endpoint. It never owns the desktop Notifications name.
#[zbus::interface(name = "org.aiolm.NotificationLifetimeTest")]
impl DelayedReply {
    async fn hold_reply(&self) {
        self.calls.fetch_add(1, Ordering::SeqCst);
        // zbus dispatches this fixture on its async-io executor. Schedule the
        // timer on the test's existing Tokio runtime, without changing zbus's
        // runtime features or constructing a nested runtime.
        let finished = self.finished.clone();
        self.runtime
            .spawn(async move {
                tokio::time::sleep(OPERATION_TIMEOUT + Duration::from_millis(250)).await;
                finished.store(true, Ordering::SeqCst);
            })
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn uncertain_timeout_keeps_the_sender_and_does_not_replay() {
    let bus = Bus::start().await;
    let calls = Arc::new(AtomicUsize::new(0));
    let finished = Arc::new(AtomicBool::new(false));
    let endpoint = zbus::connection::Builder::address(bus.address.as_str())
        .unwrap()
        .name("org.aiolm.NotificationLifetimeTest")
        .unwrap()
        .serve_at(
            "/sample",
            DelayedReply {
                calls: calls.clone(),
                finished: finished.clone(),
                runtime: tokio::runtime::Handle::current(),
            },
        )
        .unwrap()
        .build()
        .await
        .unwrap();
    let service = NotificationService::default();
    let mut cached = service.connection.try_lock().unwrap();
    let client = connection(&mut cached, bus.connect()).await.unwrap();
    let name = client.unique_name().unwrap().to_string();
    let request = bounded(client.call_method(
        Some("org.aiolm.NotificationLifetimeTest"),
        "/sample",
        Some("org.aiolm.NotificationLifetimeTest"),
        "HoldReply",
        &(),
    ));
    let concurrent = async {
        tokio::time::timeout(OPERATION_TIMEOUT, async {
            while calls.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(service
            .submit("sample", "generic body")
            .await
            .unwrap_err()
            .contains("already"));
    };
    let (result, ()) = tokio::join!(request, concurrent);
    assert!(result.unwrap_err().contains("timed out"));
    assert!(!client.is_closed());
    tokio::time::timeout(OPERATION_TIMEOUT, async {
        while !finished.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let next = connection(&mut cached, bus.connect()).await.unwrap();
    assert_eq!(next.unique_name().unwrap().as_str(), name);
    // The healthy sender remains usable after the uncertain result/late reply.
    assert!(has_owner(next, &name).await);
    drop(cached);
    drop(service);
    drop(endpoint);
    bus.stop().await;
}

#[test]
fn only_a_nonzero_uint_reply_confirms_submission() {
    let call = zbus::Message::method_call("/sample", "Notify")
        .unwrap()
        .build(&())
        .unwrap();
    for value in [0u32, 1u32] {
        let reply = zbus::Message::method_return(&call.header())
            .unwrap()
            .build(&value)
            .unwrap();
        assert_eq!(accepted_id(reply).is_ok(), value != 0);
    }
    let wrong = zbus::Message::method_return(&call.header())
        .unwrap()
        .build(&"wrong type")
        .unwrap();
    assert!(accepted_id(wrong).is_err());
}
