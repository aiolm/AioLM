# Privacy policy

Last updated: 2026-09-21

AioLM is a local-first Windows desktop application. It checks public GitHub release metadata at desktop startup to notify users of application updates. Other network operations occur when using the corresponding features described below.

## Data collection

The current application does not include telemetry, advertising, analytics, crash-reporting, or background usage tracking. It does not send a usage profile or diagnostic report to the aiolm maintainers.

The application can store application settings, projects, chat threads, model metadata, runtime files, downloaded models, and local diagnostics on the user’s computer. These are created or managed as a result of the user’s actions and remain under the user’s control.

## Network requests

The following network requests can occur:

- GitHub API, GitHub release assets, and commit archives for runtime discovery, release metadata, and explicitly requested pull-request builds.
- Hugging Face API and model files when the user searches Discover or downloads a selected model/projector.
- A local or remote LLM endpoint selected by the user for chat, embeddings, model lists, or compatible API features. The endpoint receives the request data required to perform that operation.
- User-configured MCP servers and developer gateways. These are third-party programs or endpoints and should be trusted and reviewed by the user.
- GitHub release metadata and assets when the user runs `install.ps1` to install or verify a release.
- One GitHub release metadata check at desktop startup, and additional checks requested in **Settings → General → Application updates**. The request identifies the app version in its User-Agent and sends normal network metadata, without local settings, models or conversations. Installer assets and checksums are downloaded only after the user confirms an update; **Open release page** opens the public release page in the user's browser.

AioLM does not silently upload local models, documents, chat history, prompts, or settings to the project maintainer. A user-selected remote endpoint or third-party service may process data sent to it; users should review that service’s privacy policy and terms.

## Credentials and local services

Credentials for a user-configured endpoint are used for that endpoint request and are not sent to aiolm maintainers. The desktop-managed server binds to the local loopback interface and uses a per-start local bearer token; users must not expose or forward that endpoint. See [SECURITY.md](../SECURITY.md).

## Third-party services

During an update check or a user-requested network operation, the relevant provider may receive normal connection and request metadata under its own policies:

- [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement)
- [Hugging Face Privacy Policy](https://huggingface.co/privacy)
- The privacy policy of any user-configured LLM, MCP, proxy, or gateway service

## Changes and contact

Material changes to this policy will be announced in the repository and reflected in the “Last updated” date. For privacy or security questions, contact the maintainer privately through the instructions in [SECURITY.md](../SECURITY.md).

