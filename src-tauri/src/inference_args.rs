//! Effective host-only placement for runtimes that also contain GPU backends.

/// CPU is an execution choice, even when its archive also includes Metal.
/// Apply this after inherited defaults and raw options have been assembled;
/// saved tuning profiles can retain their accelerator settings for later use.
pub(crate) fn force_cpu(args: &mut Vec<String>) {
    let mut source = std::mem::take(args).into_iter().peekable();
    while let Some(argument) = source.next() {
        let (name, inline_value) = argument
            .split_once('=')
            .map_or((argument.as_str(), false), |(name, _)| (name, true));
        let takes_value = matches!(
            name,
            "--device"
                | "-dev"
                | "--n-gpu-layers"
                | "--gpu-layers"
                | "-ngl"
                | "--main-gpu"
                | "-mg"
                | "--split-mode"
                | "-sm"
                | "--tensor-split"
                | "-ts"
                | "--override-tensor"
                | "-ot"
                | "--spec-draft-device"
                | "--device-draft"
                | "-devd"
                | "--spec-draft-ngl"
                | "--n-gpu-layers-draft"
                | "--gpu-layers-draft"
                | "-ngld"
                | "--spec-draft-override-tensor"
                | "--override-tensor-draft"
                | "-otd"
                | "--mmproj-device"
                | "-mmdev"
        );
        let switch = matches!(
            name,
            "--kv-offload"
                | "-kvo"
                | "--no-kv-offload"
                | "-nkvo"
                | "--op-offload"
                | "--no-op-offload"
                | "--mmproj-offload"
                | "--no-mmproj-offload"
        );
        if takes_value {
            if !inline_value
                && source
                    .peek()
                    .is_some_and(|value| !value.starts_with('-') || value.parse::<f64>().is_ok())
            {
                source.next();
            }
        } else if !switch {
            args.push(argument);
        }
    }
    args.extend(
        [
            "--device",
            "none",
            "--n-gpu-layers",
            "0",
            "--no-kv-offload",
            "--no-op-offload",
        ]
        .map(str::to_string),
    );
}

/// Server-only auxiliaries are not accepted by every standalone runtime tool.
pub(crate) fn force_cpu_server(args: &mut Vec<String>, draft_enabled: bool) {
    force_cpu(args);
    args.push("--no-mmproj-offload".to_string());
    if draft_enabled {
        args.extend(["--spec-draft-device", "none", "--spec-draft-ngl", "0"].map(str::to_string));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_placement_removes_aliases_and_tensor_overrides_but_keeps_workload_options() {
        let mut args = [
            "--model",
            "synthetic.gguf",
            "-dev",
            "MTL0",
            "--gpu-layers=all",
            "-ngl",
            "-1",
            "--main-gpu=2",
            "-sm",
            "row",
            "-ts=1,2",
            "-ot",
            "blk.*=MTL0",
            "--spec-draft-override-tensor=blk.*=MTL0",
            "--device-draft=MTL0",
            "-ngld",
            "99",
            "-mmdev",
            "MTL0",
            "-kvo",
            "--op-offload",
            "--mmproj-offload",
            "--threads",
            "4",
            "--seed",
            "-1",
            "--no-mmap",
        ]
        .map(str::to_string)
        .to_vec();
        force_cpu(&mut args);
        assert_eq!(
            args,
            [
                "--model",
                "synthetic.gguf",
                "--threads",
                "4",
                "--seed",
                "-1",
                "--no-mmap",
                "--device",
                "none",
                "--n-gpu-layers",
                "0",
                "--no-kv-offload",
                "--no-op-offload",
            ]
        );
        let previous = args.clone();
        force_cpu(&mut args);
        assert_eq!(args, previous);
    }

    #[test]
    fn cpu_server_disables_projector_and_active_draft_without_enabling_speculation() {
        let mut args = Vec::new();
        force_cpu_server(&mut args, false);
        assert!(args.iter().any(|arg| arg == "--no-mmproj-offload"));
        assert!(!args.iter().any(|arg| arg.starts_with("--spec-draft")));
        force_cpu_server(&mut args, true);
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--spec-draft-device", "none"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--spec-draft-ngl", "0"]));
    }
}
