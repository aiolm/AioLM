# Model selection and settings

Choose a model without leaving the current screen. The header controls the default execution. Chat controls the selected session. Benchmark and project settings apply to their own targets, shown at the top of the dialog.

The model library uses the available width for files. Click a model card to open its settings; its file and execution buttons perform their own actions. Expand the folder row to change the library location. Each model's path, copy-path button and delete button are always visible. Loaded sessions provide settings and start/stop actions directly in each row. Expand a session name for its saved name, diagnostics and removal; load policy is under **Load options**.

Models are distinguished by their actual loaded state across all sessions. Unloaded models have no active or inactive designation. The header shows the default session's loaded model; when it is stopped, choose a model to load. The stopped default session is hidden from the session list. Named saved sessions remain available to load directly, including sessions saved with a disabled flag in older configurations. Per-model settings are preserved after unloading.

Model selection opens the shared settings dialog directly. Its **Model** section searches local models and restores their saved execution settings. Use the other sections in the same dialog to adjust the runtime, GPU placement, context and memory options, sampling, reasoning, projector, draft model, LoRA adapters or advanced arguments. Selecting a model for preview does not stop a running server. Incomplete split models are identified before launch.

Execution options are editable immediately, including values inherited from the runtime. Editing a value creates an override in the selected profile's working draft. **Reset to default** restores its default and keeps the input available for further edits. Focusing or leaving an unchanged field does not create an override.

## Applying changes

- **Save profile** saves all edited options to the profile named beside the button, updates the requesting target and keeps the editor open with the saved values. Further edits use the latest saved revision. Request-only changes can affect subsequent requests when the same model and server configuration are running. Server configuration changes require a reload; the running server keeps its current settings until then.
- **Save profile & start**, **Save profile & restart**, or **Save profile, switch & start** saves the selected profile before starting the requested operation. The existing policy for stopping other sessions still applies and is shown in the dialog. An active response must finish or be stopped first.
- Benchmark settings use the same **Save profile** action before updating the benchmark target. Workload-controlled settings are explained in the dialog. Start the measurement from the benchmark page after stopping running model sessions.
- Project settings use **Save profile** before updating the project editor. Save the project separately; applying the saved project to default execution remains an explicit action. Its system prompt is edited and saved through the profile's model settings.

The header Close button or Escape closes the editor. If pending changes exist, the dialog offers to keep editing or discard them. Completed profile saves, renames, default designations, deletions and applications remain saved after closing. A failed save preserves the draft. During model loading, Cancel stops the pending launch; settings that were saved before loading remain available for correction and retry.

## Settings profiles

The **Profiles** section displays reusable **Global profiles** and **Model profiles** for the selected model. A new installation starts with one editable **Default** global profile, named in the selected interface language. Its values inherit runtime defaults and its system prompt is empty. No additional presets are generated. Select a chip to preview its saved settings without changing the editor or the model's saved settings. Selecting the same chip again or closing the preview returns to the current settings card.

One profile is designated as the default, shown by a badge independent of its name. Any profile can become the default. Designating a Model profile makes it available to all models while preserving its identity and saved values. Changing the designation preserves unsaved option values and the prompt in the editor, including invalid inputs that still need correction.

Every execution workspace has a selected profile, including the initial workspace before a model is chosen. Editing keeps that profile selected and shows its name with an **Editing** indicator. The profile banner stays visible while scrolling, names the actual save target and writes the options and prompt into that profile together with the target's application snapshot. Execution options cannot be saved only to a model. One **Save as new** action is available above the settings in every section; its form lets the user choose Global or Model scope and confirms with **Create new profile**. The selected chip keeps its checkmark while another chip can be previewed independently. The **Current values** card displays the working values; a preview displays the saved profile's name and values. The Editing indicator clears when all options and the prompt return to their saved values; invalid input remains marked until corrected. Execution changes can still require a reload before the running engine uses them.

| Action | Result |
| --- | --- |
| **Select this profile** in a preview | Selects that saved profile for the target and keeps the dialog open. It does not automatically restart a model. |
| **Save as new** | Creates a Global or Model profile from the working settings, then applies it to the current target. |
| **Save profile** in the fixed profile banner | Saves the edits into the named selected profile and its target, then clears the editing indicator and keeps the editor open. Previewing another profile does not change the save target. |
| **Rename** | Saves the new name immediately without overwriting the profile's setting values. |
| **Set as default** | Designates the previewed or current profile as the default. Keeps the current model's assignment and the editor's unsaved values and prompt. |
| **Delete profile** | Removes the profile and its generated model copies after confirmation. Models and sessions using them receive the designated default's settings and prompt. Only the designated default is protected; choose another default before deleting it. |
| **Revert** | Reads the selected profile's latest saved values and discards edits while preserving its profile assignment. |
| **Reset all to defaults** | Resets every profile field in the working draft, including the runtime, GPU placement, auxiliary files, adapters, advanced arguments and system prompt. Brief feedback in the profile banner confirms the reset or reports that the values were already at their defaults. Keeps the selected model and the saved profile library. Save the working settings to retain the reset. Benchmark workload settings remain unchanged. |

Successful profile saves, applications, renames and deletions reload the target's saved settings and clear the working draft. This also applies after renaming or deleting a profile that is not currently applied. **Set as default** preserves the working draft and its unsaved indicator. A failed save leaves the working draft available to retry.

Both Global and Model profiles save all editable execution settings, including runtime builds, GPU placement, offload, auxiliary models, projectors, adapters, raw server arguments and the default system prompt. Scope controls where a profile can be selected: Global profiles are available across models, while Model profiles belong to one model. Runtime-default markers are preserved along with explicit values. Selecting or saving a profile keeps its identity and does not create a model-specific copy. Copies from older configurations remain visible as independent profiles; editing one updates that selected profile rather than its former source.

Saving a profile preserves other targets' saved application snapshots and running processes. Explicit profile selection and the next model or session launch use the profile's latest saved values. A running process keeps its current options until an explicit request-setting update or reload.

The details card shows the profile's setting values before applying it. The defaults card explains values used when an option has no override. Older anonymous settings are preserved in a named recovered profile. Explicit references to a deleted profile use the designated default.

Each editable setting shows its explanation below the control in the selected interface language, without a separate help tooltip. Advanced options also show their explanation while collapsed; additional server arguments and request JSON explain their format and when changes take effect. Descriptions are linked to their inputs for assistive technology. Bundled server options include Korean, Japanese and Chinese explanations. Unregistered runtime options show a localized notice when a translation is unavailable. CLI flags, protocol keys and literal argument values keep their original spelling.

Tuning fields show one concise explanation, a compact default value and a reset action. **Technical details** expands the CLI mapping, request key, default qualifications and source. Dropdown labels move focus without opening the menu; the control itself and keyboard activation open it. Sampler order uses numbered, equal-width tiles with fixed move and remove buttons, adapting the number of columns to the available width.

Generation settings include a default system prompt for new conversations. Existing conversations retain their own prompts. Saving changes that require a reload preserves the running session's current request settings and prompt until a subsequent selection or restart. Projects receive the saved profile's execution settings and prompt in their editor; saving the project is a separate action. Benchmark delivery leaves its workload-controlled fields unchanged.

When a profile action changes a default or session target, its library changes and copied target settings are saved in one native configuration write. Deletion also saves the affected targets' replacement profile settings in that write. Renaming and default designation update profile metadata. Project and benchmark settings remain scoped to their requesting editor. Projects retain the selected profile identity when saved, reopened, imported or exported. An older project without an identity receives a named profile containing its saved values. A project referring to a deleted profile uses the designated default's settings and prompt when reopened in the settings editor or applied; it does not recreate the deleted profile. If another editor changes the profile library, reopen the dialog to review the latest values. If a save succeeds but launch or delivery fails, the dialog identifies the completed save and retains a retryable editor without duplicating newly created profiles.

## Existing data and resources

Per-model remembered settings and existing profiles remain available. Previous server, generation and loading profiles are imported individually. Missing or empty libraries receive the Default profile without copying current user settings. Existing anonymous legacy snapshots receive a matching profile or a named recovery containing their saved values and prompt. The default designation is stored separately from the profile name; a profile named Default can be deleted after another profile becomes the default. Models without saved settings use the designated default, including projector, draft model and LoRA settings when that profile explicitly owns those fields. Saved sessions retain independent execution settings and named profile applications.

Downloading a model adds it to the library. **Configure and run** then opens its settings; cancelling that dialog leaves the downloaded file intact. Runtime installation remains on the runtime management page. Going there from settings preserves the draft and offers a return action; runtime capabilities are refreshed on return.

The application's server port is a global setting rather than a model override. Changing it takes effect on the next launch. Running status continues to show the current server's address and model.
