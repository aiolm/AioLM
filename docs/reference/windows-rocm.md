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

ROCm runtimes that AioLM builds from llama.cpp source use the upstream
peer-copy behavior; they do not force `GGML_CUDA_NO_PEER_COPY`. AioLM's launch
check still tests the selected GPU placement, and a failing runtime is not made
usable by disabling an engine feature.

## Portable packaging

When AioLM builds a ROCm runtime from source, set `HIP_PATH` or `ROCM_PATH` to
the SDK used for the build. Packaging the runtime:

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

Import/export verifies the bundle's file hashes. Earlier launch-check results
are keyed by the runtime's file names, sizes and modification times, including
GPU kernel data, so replacing a vendor dependency under the same engine build
discards them. This identity only decides when to check again; it does not
replace archive integrity checks.

## Troubleshooting

- **Long paths.** The Windows TensileLite library can fail to load its kernel
  data when a data file's full path exceeds 260 characters, even though the
  files were copied correctly. Keep the AioLM data folder (`AIOLM_HOME`) and
  runtime locations on short paths.
- **Multi-GPU results differ or the launch check fails.** Confirm that the AMD
  runtime includes the fix described in [Multi-GPU correctness](#multi-gpu-correctness).
  Updating llama.cpp alone does not update the AMD libraries it loads.
- **Mixed SDK files.** Packaging refuses to combine a bundle with ROCm DLLs from
  another SDK. Start from one complete SDK installation.
