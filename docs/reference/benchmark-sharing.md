# Benchmark history and sharing

Benchmark results are saved on your computer. Sharing a result on the AioLM
website is optional and happens only when you publish it. The website stores
published results and handles their public pages, edits and deletion. There are
no user accounts: a published result is managed with an owner key that AioLM
keeps in your operating system's credential store.

## Local history

The benchmark runner saves each run in `benchmarks/runs` under the data folder
(`~/.aiolm`, or `AIOLM_HOME`). A run's journal contains its launch metadata,
completed trials and final status. Completed trials are written as they finish,
so an interrupted run keeps the measurements it completed. A damaged record is
kept and reported without hiding the rest of the history. History loads in
pages of at most 100 runs.

Results that earlier versions kept in browser storage are imported the first
time history opens. The original browser data is left unchanged, and an
interrupted import is safe to retry.

Excel, CSV and Markdown exports contain a readable results report without local
paths. See [Benchmarks](benchmarks.md) for measurement details, exports and
deletion.

## What a shared result contains

A shared result contains numeric measurements, the workload and corpus
identity, model identity and format (plus declared metadata for GGUF models),
the inference engine and its version, selected execution settings, the launch options used for the measurement and a
hardware snapshot (including the CPU's thread count and, when the operating
system reports it, its physical core count).

It never contains local file names or paths, error messages, machine
fingerprints, persistent device identifiers or local record IDs. Launch options
that name your machine, such as model, projector, draft and LoRA files, host and
port, aliases, prompt text and anything that looks like a credential, are
removed together with their values. Unknown values stay empty rather than being
filled in from your current machine.

The engine is llama.cpp, vLLM or MLX, and its version is the one the engine
itself reports: the version line of the llama.cpp runtime, for example
`0.3.0-dev (build 10638, commit bf9421646)`, or the installed vLLM or MLX package
version. vLLM on Apple Silicon (Metal) also records its Metal plugin version
separately. Compiler and build-host details are not included. A runtime that
reports no version publishes none.

When you compare results, keep these limits in mind:

- A selected GPU records how the run was configured, not proof that every layer
  ran there. CPU mode, explicit selection and automatic placement stay distinct.
- Compare speedups only between runs with the same prompt size, output size and
  timing method. Cached prompts and failed or missing samples cannot establish a
  speedup.
- For GGUF models, declared metadata states what the file says about itself; it
  does not prove identical tensors or quality. A complete SHA-256 distinguishes exact files when
  available; multipart models have no single digest.
- Results are self-reported local measurements. The website does not verify them
  and they are not a universal hardware ranking.

## Publishing a result

Select a result and expand **Share result**. It shows a readable summary of the
public model information, hardware, runtime, measurement conditions and
results, an optional description and one publish action. The description
accepts Markdown paragraphs, lists, HTTP(S) links and code blocks, up to 4000
characters.

AioLM freezes the exact reviewed content before publishing, so retries send the
identical result and cannot create duplicates. The website may ask you to
complete a browser verification first. After the upload, the publish action is
replaced by website management; reopening the result later shows the same
state without uploading again. Uploads are paused while a benchmark is
measuring, and starting a measurement cancels an upload in progress. Because a
cancelled request may already have reached the website, publishing again
returns the existing result rather than a copy.

### Publishing service

Builds publish to the official AioLM website, `https://aiolm.vercel.app`. A build
can choose another service, or disable publishing, with the
`AIOLM_BENCHMARK_API_URL` setting at build time: an unset or blank value uses
the official website, a root HTTPS origin selects another service, and `off`
disables publishing. An invalid value also disables publishing rather than
falling back to the official website. When publishing is disabled, the summary
and local exports remain available. See
[Build from source](../guides/install.md#build-from-source).

## Managing shared results

**Shared results** lists the results you have published from this computer,
with a website management action for each. Choosing it signs you in to the
website's management page in your browser without showing the owner key. The
sign-in link expires after two minutes and works once. Opening management never
edits or deletes a result by itself.

Edit a result's description or delete it on the website. Deleting removes the
result's data; the website keeps only a minimal record that it existed.
Removing local history or cached copies in AioLM never deletes a published
result.

### Backup and restore

Your owner key is the only permission to edit or delete a published result.
Expand **Backup and restore** in **Shared results** to save a backup file or
copy a recovery code for each result. Keep backups private: anyone with one has
the same permission you do.

- To manage results after reinstalling or on another computer, import the
  backup file there. Import works even when the list is empty.
- The website's management page also accepts AioLM backup `.txt` files; you can
  select several and choose a result from the list. Pasting a recovery code
  remains available as a fallback.

A lost owner key without a backup cannot be recovered.

## Local copies of published results

After the website confirms a result, AioLM records the receipt before cleaning up
local data, so a failed local step is retried without uploading again. AioLM
keeps the 100 most recent local copies of runs it measured and published; older
copies of those runs are removed automatically. Runs that are in progress,
interrupted, not uploaded, failed or cancelled, imported from earlier versions,
or saved before this policy are always kept, so history can hold more than 100
runs.

Publishing state is kept in the app's browser storage, separately from run
history. Clearing that storage can lose unfinished publishing state; your run
history and owner keys are not affected.
