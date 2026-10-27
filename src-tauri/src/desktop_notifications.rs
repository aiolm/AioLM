//! Linux notification transport with an application-owned bus connection.
//!
//! GNOME can remove an application's notifications when its sender disconnects.
//! Retaining one connection keeps a completed Notify call from immediately
//! dismissing its own alert. The desktop still decides whether to display it.

use std::collections::HashMap;
use std::future::Future;
use std::time::Duration;
use tokio::sync::Mutex;
use zbus::Connection;

const OPERATION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Default)]
pub(crate) struct NotificationService {
    // One connection for the application, rather than a handle/task per alert.
    connection: Mutex<Option<Connection>>,
}

async fn bounded<T>(operation: impl Future<Output = zbus::Result<T>>) -> Result<T, String> {
    tokio::time::timeout(OPERATION_TIMEOUT, operation)
        .await
        .map_err(|_| "Desktop notification service timed out".to_string())?
        .map_err(|_| "Desktop notification service is unavailable".to_string())
}

async fn connection(
    cached: &mut Option<Connection>,
    connect: impl Future<Output = zbus::Result<Connection>>,
) -> zbus::Result<&Connection> {
    if cached.as_ref().is_some_and(Connection::is_closed) {
        *cached = None;
    }
    if cached.is_none() {
        *cached = Some(connect.await?);
    }
    Ok(cached.as_ref().expect("connected above"))
}

fn accepted_id(reply: zbus::Message) -> Result<(), String> {
    match reply.body().deserialize::<u32>() {
        Ok(id) if id != 0 => Ok(()),
        _ => Err("Desktop notification service returned an invalid reply".to_string()),
    }
}

impl NotificationService {
    pub(crate) async fn submit(&self, title: &str, body: &str) -> Result<(), String> {
        // Do not queue an unbounded number of alerts while the service is slow.
        let mut cached = self
            .connection
            .try_lock()
            .map_err(|_| "A desktop notification is already being submitted".to_string())?;
        // Match the plugin's Linux app-name/auto-icon convention without
        // exposing the executable's directory to the notification service.
        let executable = std::env::current_exe()
            .map_err(|_| "Could not identify the notification application".to_string())?;
        let name = executable
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Could not identify the notification application".to_string())?;
        // One deadline covers acquisition, sending and waiting for the reply.
        // Dropping a timed-out wait does not undo remote acceptance.
        let reply = bounded(async {
            let bus = connection(&mut cached, Connection::session()).await?;
            bus.call_method(
                Some("org.freedesktop.Notifications"),
                "/org/freedesktop/Notifications",
                Some("org.freedesktop.Notifications"),
                "Notify",
                &(
                    name,
                    0u32,
                    name,
                    title,
                    body,
                    Vec::<String>::new(),
                    HashMap::<String, zbus::zvariant::Value<'_>>::new(),
                    -1i32,
                ),
            )
            .await
        })
        .await?;
        // Keep the connection even after an uncertain timeout/error. Never
        // replay a possibly accepted alert; the next explicit submission can
        // replace a connection that has actually closed.
        accepted_id(reply)
    }
}

#[cfg(test)]
mod tests;
