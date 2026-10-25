# AppImage type2 runtime

Linux packaging (`npm run package:tauri`, `scripts/package-tauri.mjs`) embeds this source-built AppImage runtime
instead of the upstream download. It is upstream
[AppImage/type2-runtime](https://github.com/AppImage/type2-runtime) at `fedfad51acc2860b2916a1eef32ba4a500ff31ef`
with two patches:

| Patch | Fixes |
| --- | --- |
| `0001-rm_recursive-pass-positive-nftw-fd_limit.patch` | `--appimage-extract-and-run` never removed `$TMPDIR/appimage_extracted_*`: musl's `nftw()` returns without visiting anything when `fd_limit` is 0. |
| `0002-extract-and-run-use-a-per-instance-directory.patch` | With cleanup working, a second instance that exits would delete the tree a running instance uses. Each instance now extracts into its own `mkdtemp()` directory. |

Cleanup was validated for the product payload (7 directory levels). musl's `nftw()` descends at most 64 levels.

## How packaging uses it

`pins.conf` names the single accepted binary (`RUNTIME_SHA256`). Before `tauri build`, `runtime.mjs` picks the
first of these that exists:

1. `LDAI_RUNTIME_FILE` from the environment. It must be that exact binary, or packaging stops.
2. The cache entry `<cargo target dir>/appimage-runtime/<RUNTIME_SHA256>/runtime-x86_64`. It is re-hashed on every
   use and rebuilt if it differs. The cache is disposable; delete that directory to force a rebuild.
3. A fresh `build.sh` run. Its output must match the pin before it is cached.

The chosen path is passed to linuxdeploy-plugin-appimage as `LDAI_RUNTIME_FILE`. After the build, every new AppImage
in `bundle/appimage/` must start with exactly this runtime; only the image digest that appimagetool writes may
differ. The runtime is re-read and re-hashed then, so a file swapped during the build also fails packaging. Windows
and macOS packaging are unchanged.

The pinned runtime is x86-64 only. Linux packaging on another architecture stops before `tauri build` rather than
injecting the wrong architecture from an override or a cache.

## Building

Requirements: an x86-64 Linux host with `bwrap` (bubblewrap) and unprivileged user namespaces, plus `git`, `curl`,
`gpg`, `patch`, `tar`, `sha256sum`, `/dev/fuse` and network access. On Debian or Ubuntu:

```sh
sudo apt-get install bubblewrap git curl gnupg patch
```

No root, Docker or sudo is used by the build itself. Ubuntu 24.04+ restricts unprivileged user namespaces through
AppArmor. Allow `bwrap` with a scoped AppArmor profile, or on a disposable build host run
`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`. Packaging checks this before building and prints
the remediation instead of failing later inside `bwrap`. The Linux CI jobs install bubblewrap and relax that sysctl
conditionally on their disposable Ubuntu 24.04 runners.

```sh
sh scripts/appimage-runtime/build.sh <new-work-dir>   # -> <new-work-dir>/out/runtime-x86_64 (~1 min)
```

`build.sh` runs upstream's chroot build (`scripts/chroot/chroot_build.sh`) inside an unprivileged bubblewrap
namespace instead of `sudo chroot`:

- the Alpine 3.21.0 minirootfs, checked against its pinned SHA-256 and a signature by the pinned key from upstream's
  `ncopa.asc`;
- the package list from upstream's Dockerfile, which must resolve to exactly `apk.lock`;
- upstream's own `install-dependencies.sh` (libfuse 3.15.0, squashfuse 0.5.2, each SHA-256 checked) and
  `build-runtime.sh`.

The result must equal `RUNTIME_SHA256`. During validation, the same recipe without the patches reproduced the
upstream release binary bit for bit; the committed recipe always applies both patches.

Alpine 3.21 is a moving stable branch. When its packages change, the `apk.lock` check stops the build with a diff.
To update, review the new package set, rebuild, and commit `apk.lock` and `RUNTIME_SHA256` together. Until then,
packaging can use a previously built runtime with the pinned hash through `LDAI_RUNTIME_FILE`.

## Licenses

- `LICENSE.type2-runtime` is the upstream MIT license, unchanged; the patches are under the same license.
- The runtime statically links, as upstream's release does:
  - libfuse 3.15.0 (LGPL-2.1);
  - squashfuse 0.5.2 (BSD-2-Clause);
  - zstd 1.5.6 (BSD-3-Clause or GPL-2.0);
  - zlib 1.3.2 (Zlib);
  - mimalloc 2.1.7 (MIT);
  - musl 1.2.5 (MIT).
- Their exact sources are the pinned upstream tarballs and `apk.lock` above.
