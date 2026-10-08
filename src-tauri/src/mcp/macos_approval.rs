//! A Cocoa approval window owned by the tool call, including cancellation.
//!
//! Run NSAlert in its own system scripting process instead of rfd's detached
//! dialog future. Dropping the owner closes this specific window and process;
//! other app dialogs are unaffected. Tool text is passed as data in argv.

use crate::procutil::TransientChild;
use std::process::Stdio;
use tokio::io::AsyncReadExt;
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
    const response = alert.runModal;
    if (response === $.NSAlertFirstButtonReturn) {
        return 'rejected';
    }
    if (response !== $.NSAlertSecondButtonReturn) {
        throw new Error('Unexpected MCP approval response');
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
    command.stdout(Stdio::piped());
    let mut child = TransientChild::spawn(&mut command)
        .map_err(|error| format!("cannot open MCP tool approval: {error}"))?;
    // Only the dialog's explicit answer can approve or reject. A scripting
    // failure must reach the caller as an error, not as a user's No choice.
    // Bound the reply while retaining the cancellable process-tree owner.
    let mut stdout = child
        .stdout
        .take()
        .expect("captured approval reply")
        .take(32);
    let mut reply = Vec::new();
    let read_reply = async {
        stdout.read_to_end(&mut reply).await?;
        if reply.len() == 32 {
            return Err(std::io::Error::other("approval reply exceeded its limit"));
        }
        Ok(())
    };
    let (status, ()) = tokio::try_join!(child.wait(), read_reply)
        .map_err(|error| format!("cannot read MCP tool approval: {error}"))?;
    if !status.success() {
        return Err(format!(
            "MCP tool approval failed ({status}); tool was not run"
        ));
    }
    match reply.as_slice() {
        b"approved\n" => Ok(true),
        b"rejected\n" => Ok(false),
        _ => Err("MCP tool approval returned an invalid answer; tool was not run".into()),
    }
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
    async fn only_an_explicit_dialog_answer_approves_or_rejects() {
        for (reply, approved) in [("approved", true), ("rejected", false)] {
            let mut command = crate::procutil::tokio_command("/bin/sh");
            command.args(["-c", &format!("printf '{reply}\\n'")]);
            assert_eq!(answer(command).await.unwrap(), approved);
        }
    }

    #[tokio::test]
    async fn successful_exit_without_an_exact_answer_does_not_approve() {
        for script in [
            "exit 0",
            "printf 'approved'",
            "printf 'approved\\nextra'",
            "printf 'unexpected\\n'",
            "printf '%100s' 'approved'",
        ] {
            let mut command = crate::procutil::tokio_command("/bin/sh");
            command.args(["-c", script]);
            assert!(answer(command)
                .await
                .unwrap_err()
                .contains("MCP tool approval"));
        }
    }

    #[tokio::test]
    async fn oversized_reply_does_not_wait_for_a_full_output_pipe() {
        let mut command = crate::procutil::tokio_command("/bin/sh");
        command.args(["-c", "while :; do printf 'unexpected answer\\n'; done"]);
        let error = timeout(Duration::from_secs(5), answer(command))
            .await
            .expect("invalid output must end approval before its external deadline")
            .unwrap_err();
        assert!(error.contains("approval reply exceeded its limit"));
    }

    #[tokio::test]
    async fn system_javascript_returns_the_expected_answer_protocol() {
        // Exercise osascript's serialization without opening or operating UI.
        for (reply, approved) in [("approved", true), ("rejected", false)] {
            let mut command = crate::procutil::tokio_command("/usr/bin/osascript");
            command.args([
                "-l",
                "JavaScript",
                "-e",
                "function run(args) { return args[0]; }",
                "--",
                reply,
            ]);
            assert_eq!(answer(command).await.unwrap(), approved);
        }
    }

    #[tokio::test]
    async fn dialog_failure_is_not_reported_as_user_rejection() {
        for script in ["exit 1", "exit 5", "printf 'approved\\n'; exit 1"] {
            let mut command = crate::procutil::tokio_command("/bin/sh");
            command.args(["-c", script]);
            let error = answer(command).await.unwrap_err();
            assert!(error.contains("MCP tool approval"));
            assert!(!error.contains("rejected by the user"));
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
