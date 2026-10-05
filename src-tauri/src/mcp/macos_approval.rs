//! A Cocoa approval window owned by the tool call, including cancellation.
//!
//! Run NSAlert in its own system scripting process instead of rfd's detached
//! dialog future. Dropping the owner closes this specific window and process;
//! other app dialogs are unaffected. Tool text is passed as data in argv.

use crate::procutil::TransientChild;
use std::process::Stdio;
use tokio::process::Command;

const SCRIPT: &str = r#"ObjC.import('AppKit');
function run(args) {
    const app = $.NSApplication.sharedApplication;
    app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
    const alert = $.NSAlert.alloc.init;
    alert.messageText = args[0];
    alert.informativeText = args[1];
    alert.alertStyle = $.NSAlertStyleInformational;
    alert.addButtonWithTitle('No');
    alert.addButtonWithTitle('Yes');
    app.activateIgnoringOtherApps(true);
    if (alert.runModal !== $.NSAlertSecondButtonReturn) {
        throw new Error('MCP approval rejected');
    }
    return 'approved';
}"#;

fn dialog_command(title: &str, description: &str) -> Command {
    let mut command = crate::procutil::tokio_command("/usr/bin/osascript");
    command
        .args(["-l", "JavaScript", "-e", SCRIPT, "--", title, description])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

pub(super) async fn confirm(title: &str, description: &str) -> Result<bool, String> {
    answer(dialog_command(title, description)).await
}

async fn answer(mut command: Command) -> Result<bool, String> {
    let mut child = TransientChild::spawn(&mut command)
        .map_err(|error| format!("cannot open MCP tool approval: {error}"))?;
    let status = child
        .wait()
        .await
        .map_err(|error| format!("cannot read MCP tool approval: {error}"))?;
    Ok(status.success())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::procutil::OwnedTask;
    use std::time::Duration;
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpListener;
    use tokio::time::timeout;

    #[test]
    fn tool_description_is_data_and_not_executable_script() {
        let description = "'); throw new Error('injected'); //\n한글 tool";
        let command = dialog_command("Approval", description);
        let args: Vec<_> = command.as_std().get_args().collect();
        assert_eq!(args[3], SCRIPT);
        assert_eq!(args[4], "--");
        assert_eq!(args[6], description);
        assert_eq!(args.len(), 7);
    }

    #[tokio::test]
    async fn only_an_explicit_success_approves() {
        for (code, approved) in [(0, true), (1, false), (5, false)] {
            let mut command = crate::procutil::tokio_command("/bin/sh");
            command.args(["-c", &format!("exit {code}")]);
            assert_eq!(answer(command).await.unwrap(), approved);
        }
    }

    #[tokio::test]
    async fn cancellation_and_timeout_reclaim_the_approval_process() {
        for timed_out in [false, true] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let mut command = crate::procutil::tokio_command("node");
            command.args(["-e", &format!("require('node:net').connect({port}, '127.0.0.1'); setInterval(() => {{}}, 1000);")]);
            let task = OwnedTask::from(tokio::spawn(async move {
                timeout(Duration::from_secs(2), answer(command)).await
            }));
            let (mut socket, _) = timeout(Duration::from_secs(10), listener.accept())
                .await
                .expect("approval fixture must start")
                .unwrap();
            if timed_out {
                assert!(task.await.unwrap().is_err());
            } else {
                task.abort();
                assert!(task.await.unwrap_err().is_cancelled());
            }
            timeout(Duration::from_secs(5), socket.read_to_end(&mut Vec::new()))
                .await
                .expect("cancelled approval must close its lifetime socket")
                .unwrap();
        }
    }

    #[tokio::test]
    #[ignore = "opens a real Cocoa approval window on a disposable hosted Mac"]
    async fn real_cocoa_window_closes_on_cancellation_and_deadline() {
        assert_eq!(
            std::env::var("AIOLM_MACOS_APPROVAL_SMOKE").as_deref(),
            Ok("1")
        );
        assert_eq!(
            std::env::var("RUNNER_ENVIRONMENT").as_deref(),
            Ok("github-hosted")
        );
        let probe = std::env::var("AIOLM_MACOS_WINDOW_PROBE").expect("compiled window probe");
        for timed_out in [false, true] {
            let mut command =
                dialog_command("AioLM synthetic approval", "Synthetic tool input 한글");
            let mut child = TransientChild::spawn(&mut command).unwrap();
            let pid = child.id().unwrap();
            let visible = |pid: u32| {
                let output = std::process::Command::new(&probe)
                    .arg(pid.to_string())
                    .output()
                    .unwrap();
                assert!(output.status.success());
                output.stdout == b"visible\n"
            };
            timeout(Duration::from_secs(20), async {
                while !visible(pid) {
                    assert!(
                        child.try_wait().unwrap().is_none(),
                        "Cocoa approval exited before showing its window"
                    );
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            })
            .await
            .expect("the real NSAlert must become visible");
            let task = OwnedTask::from(tokio::spawn(async move {
                timeout(Duration::from_secs(1), child.wait()).await
            }));
            if timed_out {
                assert!(task.await.unwrap().is_err());
            } else {
                task.abort();
                assert!(task.await.unwrap_err().is_cancelled());
            }
            timeout(Duration::from_secs(5), async {
                while visible(pid) {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            })
            .await
            .expect("cancelling approval must remove its actual window");
        }
    }
}
