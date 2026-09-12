# Model selection and settings

Choose a model without leaving the current screen. The header controls the default execution. Chat controls the selected session. Benchmark and project settings apply to their own targets, shown at the top of the dialog.

The compact picker searches local models and restores their saved execution settings. Open **Model settings** to adjust the runtime, GPU placement, context and memory options, sampling, reasoning, projector, draft model, LoRA adapters or advanced arguments. Selecting a model for preview does not stop a running server. Incomplete split models are identified before launch.

## Applying changes

- **Save for next run** keeps the current server and its request settings unchanged. Reload to use the saved server configuration.
- **Apply** updates request-only settings for subsequent requests when the same model and server configuration are running.
- **Save and start**, **Apply and restart**, or **Switch and start** validates the selected configuration before replacing a running model. The existing policy for stopping other sessions still applies and is shown in the dialog. An active response must finish or be stopped first.
- **Apply to benchmark** changes only the benchmark target. Workload-controlled settings are explained in the dialog. Start the measurement from the benchmark page after stopping running model sessions.
- **Apply to project** updates the project editor's configuration. Save the project separately; applying the saved project to default execution remains an explicit action.

Cancel discards edits that have not been applied. If changes have been made, the dialog offers to keep editing or discard them. A failed save preserves the draft. If saving succeeded but model launch failed or was cancelled, the saved settings remain available for correction and retry.

Shared profile management has its own explicit save and delete actions. Loading a profile into a draft does not change the shared profile. A profile explicitly saved in the management section remains saved if the surrounding model editor is later cancelled.

## Existing data and resources

Per-model remembered settings and existing profiles remain available. New models do not silently inherit another model's projector, draft model or LoRA adapters. Saved sessions can retain independent execution settings and a model profile; older sessions without those fields keep their existing inheritance behavior.

Downloading a model adds it to the library. **Configure and run** then opens its settings; cancelling that dialog leaves the downloaded file intact. Runtime installation remains on the runtime management page. Going there from settings preserves the draft and offers a return action; runtime capabilities are refreshed on return.

The application's server port is a global setting rather than a model override. Changing it takes effect on the next launch. Running status continues to show the current server's address and model.
