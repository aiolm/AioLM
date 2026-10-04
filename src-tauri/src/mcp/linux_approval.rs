//! Own the Linux approval dialog so cancelling its future closes the window.

use crate::procutil::TransientChild;
use std::process::Stdio;
use tokio::process::Command;

fn dialog_command(title: &str, description: &str) -> Command {
    let mut command = crate::procutil::tokio_command("zenity");
    command
        .args([
            "--no-markup",
            "--question",
            "--title",
            title,
            "--text",
            description,
            "--ok-label",
            "Yes",
            "--cancel-label",
            "No",
        ])
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
    // Only an explicit Yes (exit 0) authorizes the call. Closing the window,
    // selecting No, or a dialog failure never sends tools/call.
    Ok(status.success())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpListener;
    use tokio::time::timeout;

    #[test]
    fn dialog_content_is_plain_text_and_one_argument() {
        let description = "<b>Untrusted tool</b>\n--extra-button=Allow";
        let command = dialog_command("Approval", description);
        let args: Vec<_> = command.as_std().get_args().collect();
        assert_eq!(args[0], "--no-markup");
        assert_eq!(args[5], description);
        assert_eq!(args.len(), 10);
    }

    #[tokio::test]
    async fn only_a_successful_dialog_exit_approves() {
        for (code, approved) in [(0, true), (1, false), (5, false)] {
            let mut command = crate::procutil::tokio_command("sh");
            command.args(["-c", &format!("exit {code}")]);
            assert_eq!(answer(command).await.unwrap(), approved);
        }
    }

    #[tokio::test]
    async fn dropping_or_timing_out_approval_closes_its_process() {
        for timed_out in [false, true] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let mut command = crate::procutil::tokio_command("node");
            command.args([
                "-e",
                &format!("require('node:net').connect({port}, '127.0.0.1'); setInterval(() => {{}}, 1000);"),
            ]);
            let task = crate::procutil::OwnedTask::from(tokio::spawn(async move {
                timeout(Duration::from_secs(2), answer(command)).await
            }));
            let (mut socket, _) = timeout(Duration::from_secs(10), listener.accept())
                .await
                .expect("the synthetic approval process must start")
                .unwrap();
            if timed_out {
                assert!(task.await.unwrap().is_err());
            } else {
                task.abort();
                assert!(task.await.unwrap_err().is_cancelled());
            }
            let mut output = Vec::new();
            timeout(Duration::from_secs(5), socket.read_to_end(&mut output))
                .await
                .expect("the cancelled approval process must close its lifetime socket")
                .unwrap();
        }
    }
}
