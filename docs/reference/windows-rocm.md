# Windows ROCm runtimes

A Windows ROCm runtime consists of the llama.cpp engine, AMD runtime libraries,
BLAS kernel data, and any external `.kpack` archives. Updating only the engine
does not update the GPU runtime it loads.

## Multi-GPU correctness

AMD's [ROCm fix #10553](https://github.com/ROCm/rocm-systems/pull/10553) repairs
the Windows PAL staging-copy path used when hardware peer access is unavailable.
The runtime must complete preceding GPU work before reading its source buffer
on an internal transfer queue. Without that ordering, an asynchronous copy can
return success while transferring stale data.

Use an AMD SDK or runtime package containing that upstream fix. For packages
from TheRock, retain `share/therock/therock_manifest.json` and check the pinned
rocm-systems source revision; a recent llama.cpp build number alone is not
evidence that its AMD dependency includes the fix. Stable and nightly packages
are separate release channels. AioLM does not automatically switch channels.

The AMD `therock-dist-windows-gfx120X-all-10.2.0a20260923` nightly package pins
[rocm-systems revision 0816fc8](https://github.com/ROCm/rocm-systems/commit/0816fc809a4ff1f21c330357368f977f4ffe67fd),
which contains the fix. This identifies a dependency set for reproduction;
it is not an application default or a claim that every newer package was tested.

AioLM source builds use the upstream peer-copy behavior. They do not force
`GGML_CUDA_NO_PEER_COPY`. The numerical verification gate still tests the selected
GPU placement before launch. A failing runtime is not made usable by clearing
that gate or disabling an engine feature.

## Portable packaging

Configure `HIP_PATH` or `ROCM_PATH` to the SDK used for the build. Packaging:

- Copies the HIP, comgr and BLAS libraries, including kpack, TensileLite and
  Origami runtime dependencies when supplied by the SDK.
- Preserves `rocblas`, `hipblaslt`, `.kpack`, vendor notices under `share/doc`,
  and TheRock provenance under `share/therock`.
- Supports both flat BLAS data directories and architecture-specific `gfx*`
  subdirectories. For the latter, the BLAS library selects the architecture;
  AioLM does not set the legacy override to the parent directory.
- Points the kpack loader at the bundle's archives after relocating SDK DLLs
  from `bin/` beside the engine. Host SDK paths are removed from child processes.
- Stops after packaging one complete SDK and rejects conflicting existing
  ROCm DLLs instead of mixing them with another SDK's kernel data.

Import/export verifies the bundle's file hashes. Numerical verification also
includes runtime file names, sizes and modification times, including GPU kernel
data. Replacing a vendor dependency under the same engine build therefore
invalidates earlier passes, failures and overrides. This metadata identity is
for cache invalidation; it does not replace archive integrity checks.

## Validation

Unit tests use synthetic SDK layouts and temporary directories:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib runtime::tests
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib verify::tests
```

The opt-in Windows integration test requires two ROCm GPUs, an engine with
`llama-server`, `llama-bench`, and `llama-perplexity`, a complete matching AMD SDK,
and the pinned canary model identified in `src-tauri/src/verify.rs`. Run it in a
separate shell with an **empty test APPDATA directory**:

Use a short test output path. The tested Windows TensileLite library failed to
load its data when the complete data-file path exceeded 260 characters, even
though Rust could copy the files successfully. Keep that vendor path limitation
in mind when choosing a custom data directory.

```powershell
$env:AIOLM_LIVE_ROCM_ENGINE = 'C:\test-inputs\engine'
$env:AIOLM_LIVE_ROCM_SDK = 'C:\test-inputs\rocm-sdk'
$env:AIOLM_LIVE_ROCM_CANARY = 'C:\test-inputs\stories15M-q4_0.gguf'
$env:AIOLM_LIVE_ROCM_APPDATA = 'C:\test-output\rocm-validation'
$env:APPDATA = $env:AIOLM_LIVE_ROCM_APPDATA
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib live_rocm_sdk_bundle_passes_dual_gpu_verification -- --ignored --nocapture --test-threads=1
```

This packages the supplied SDK using production code, runs the isolated
preflight and numerical gate, exports/imports the resulting bundle, and verifies
the imported runtime again. It leaves `rocm-verified.zip`, its checksum, and
verification records in the test directory. It does not modify the input engine
or SDK. Model-specific and full-context workload testing remain separate checks.
