# SignPath Foundation onboarding

This repository contains the project-side changes needed to apply for SignPath Foundation and to connect the approved project to GitHub Actions. The application itself and the SignPath organization setup still require the maintainer to complete the external steps below.

## Current signing gaps

The committed artifact configuration signs the outer NSIS/MSI installers and `install.ps1`. It does not yet sign the installed `aiolm.exe`. Before enabling signed distribution, the workflow must also sign the application binaries and verify their signatures inside the final packages; an installer signature alone does not sign its payload. A downloaded third-party runtime must not be signed with the project's Foundation certificate.

Foundation signing requires approval and verified build provenance. It is not a certificate/private key installed on the developer's PC. Signing a release through GitHub Actions does not sign the separate executable produced by `npm run tauri dev`; local development needs a suitable signing service or certificate and a build → sign → launch step each time Rust rebuilds the binary.

For Smart App Control, use RSA code signing from a trusted provider, not a locally generated self-signed certificate. See [Microsoft's signing requirements](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control) and [SignPath Foundation conditions](https://signpath.org/terms.html). Do not disable Windows protection or change the system trust store as part of project signing setup.

## Repository readiness

| Foundation condition | Repository evidence |
| --- | --- |
| Open-source license | [MIT LICENSE](../../LICENSE) and [NOTICE](../../NOTICE) |
| Released and documented product | [GitHub Releases](https://github.com/joowon-jang/llama-board/releases), [README](../../README.md), and [Install guide](install.md) |
| Source/build ownership | Public source repository and [release workflow](../../.github/workflows/release.yml) |
| Code signing policy | [code-signing.md](../policies/code-signing.md), linked from the home/download pages |
| Privacy policy | [privacy.md](../policies/privacy.md) |
| Review protection | [.github/CODEOWNERS](../../.github/CODEOWNERS) |
| Artifact metadata restrictions | [windows-release.xml](../../.signpath/artifact-configurations/windows-release.xml) |
| CI origin verification path | Tests, build, artifact upload, and signing submission all run through GitHub-hosted Actions jobs |
| Uninstallation | Windows installer entry plus documented removal instructions in the policy and install guide |

## SignPath setup after approval

1. Apply at [SignPath Foundation](https://signpath.org/apply.html) and provide the repository URL, MIT license, existing Windows release, active maintenance, and the project policy/privacy links.
2. In SignPath, add the predefined `GitHub.com` Trusted Build System to the organization and link it to the project. Install the SignPath GitHub App for this repository when requested by the connector setup.
3. Create a project named `aiolm` with repository URL `https://github.com/joowon-jang/llama-board`.
4. Add the committed XML file as an artifact configuration and use its slug for the `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG` repository variable.
5. Create a `release-signing` policy using the SignPath Foundation certificate. Enable Trusted Build System verification and origin verification, restrict the release policy to `main`, enable the approval process, and add the Approver listed in [code-signing.md](../policies/code-signing.md).
6. Create a SignPath API token for a submitter/CI user with permission to submit requests for this project and policy. Store it only as the GitHub Actions secret `SIGNPATH_API_TOKEN`.
7. Configure these GitHub repository variables in **Settings → Secrets and variables → Actions → Variables**:

   ```text
   SIGNPATH_ORGANIZATION_ID=<SignPath organization id>
   SIGNPATH_PROJECT_SLUG=aiolm
   SIGNPATH_SIGNING_POLICY_SLUG=release-signing
   SIGNPATH_ARTIFACT_CONFIGURATION_SLUG=<artifact configuration slug>
   ```

8. Keep `AIOLM_ALLOW_UNSIGNED_RELEASES` unset or `false` after SignPath is active. It exists only as an explicit bootstrap switch before the Foundation integration is available; it does not produce a SignPath-signed release.
9. In GitHub, protect `main` with pull requests, at least one approval, required Code Owner review, resolved conversations, and blocked force-push/deletion. Require the `release-publish` environment for the publishing job and review its members.
10. Ensure every GitHub and SignPath team member has MFA enabled. Run one release from a version bump on `main`, approve the request in SignPath, verify the Authenticode signature and `checksums.txt`, then link the signed release in the application follow-up.

The workflow does not require `WINDOWS_CERTIFICATE_BASE64` or `WINDOWS_CERTIFICATE_PASSWORD`. SignPath holds the Foundation certificate and returns the signed artifact to the publishing job.

## Application summary

Use the following facts in the application:

```text
Project: aiolm
Repository: https://github.com/joowon-jang/llama-board
License: MIT
Platform: Windows x64 (NSIS and MSI installers)
Purpose: Open-source local-first desktop manager for llama.cpp runtimes, models, chat, and benchmarks
Signing artifacts: Project-built NSIS/MSI installers and install.ps1
Build system: GitHub Actions on GitHub-hosted runners
Release approval: Manual approval through SignPath release-signing policy
Policy: https://github.com/joowon-jang/llama-board/blob/main/docs/policies/code-signing.md
Privacy: https://github.com/joowon-jang/llama-board/blob/main/docs/policies/privacy.md
```
