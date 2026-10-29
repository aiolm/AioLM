# Public release verification

After the protected publication job finishes, verify the public files separately:

```sh
python3 -B scripts/verify-public-release.py \
  --version <major.minor.patch> \
  --expected-sha <full-main-commit-sha> \
  --output-dir <new-or-empty-directory> \
  --execute-cli
```

Run on Linux x86-64 with the repository's pinned Node version, Python 3,
`gh`, `dpkg-deb`, and the native CLI's shared libraries available. `gh` uses
its normal configured identity. Downloads use the public release URLs without
credentials. Do not pass credentials in arguments or copy an existing user home.

The check requires a stable, non-draft, latest release whose tag resolves to the
specified main commit. It downloads exactly ten assets, verifies all ten GitHub
SHA-256 digests and the nine entries in LF-terminated `checksums.txt`, checks DEB
version/amd64 metadata, and checks the AppImage runtime against the released pin
and the original product guards. Release assets and the tag must remain the same
throughout verification. Source files used as verification guards must match the
specified release commit.

`--execute-cli` extracts the DEB and runs the existing native CLI smoke with a
disposable home and a credential-free environment. It never installs the DEB,
runs an AppImage/installer, edits a release, or changes environment protections.
Omit that option for download/metadata checks only; the report explicitly records
that CLI execution was not requested.

Results are written to `verification-report.json` and `summary.md` even when a
check fails. Keep the directory as a CI artifact; existing results are never
overwritten. A failure after publication needs investigation and does not silently
change or withdraw the published release.

This verification does not complete package installation, actual updater/UI
acceptance, dedicated engine/hardware inference, overall Linux acceptance, or the
retained original update checks. It does not resolve SmolVLM F09.

The metadata/download/error-path checks run without network or release execution:

```sh
python3 -B -m unittest discover -s scripts -p 'test_verify_public_release.py'
```
