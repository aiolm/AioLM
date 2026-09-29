# Shared UI components

Equivalent controls use the same design across workspaces. Theme and density values live in `src/styles/app-tokens.css`; shared component appearance lives in `src/styles/app-components.css`. Feature styles arrange controls without redefining their colors, borders, typography, or interaction states.

| Role | Shared implementation |
| --- | --- |
| Action | `app-button` with `--primary`, `--secondary`, `--ghost`, or `--danger`; `--sm` and `--lg` set explicit size variants |
| Icon action | `app-icon-button`, optionally `app-icon-button--sm`; provide an accessible name |
| Text or number input | `app-input` |
| Multiline input | `app-textarea` |
| Fixed selection or editable suggestions | `CustomSelect`; `onInputChange` enables free text |
| On/off setting | `Switch` |
| Item selection | Native checkbox or radio, using the shared theme accent |
| Tabbed content | `TabNav`, with matching tab and panel IDs |
| Page navigation | `app-nav-item`, with `aria-current` |
| Metadata or count | `Badge` |
| Runtime or operation status | `StatusBadge` |
| Notice, warning, or error | `FeedbackBanner` |
| Empty result | `EmptyState` |
| Modal dialog | `ConfirmDialog` for confirmations; `app-dialog` for a custom dialog body |
| Operation progress | `ProgressBar`; omit `value` when progress is unknown |
| Panel | `app-card`, optionally `--flush`, `--tight`, `--muted`, or a semantic tone |
| Selectable list row | `app-list-row`, with `is-selected`; use `app-list-row__action` for a row's text action |

Choose variants by meaning rather than by screen. Layout classes may set width, grid position, wrapping, and surrounding spacing. Add new shared variants when an interaction genuinely needs one, rather than overriding a common control in a feature stylesheet. Keep generated chat content and specialized data visualizations separate from application controls.

## Disclosure defaults

All accordions on the benchmark page start expanded, including result sharing, shared-result management, backup and restore, run configuration, effective arguments and metric explanations. Opening sharing prepares a local review; publication and backup actions still require an explicit button press.

Other screens expose current information selectively: running-model memory and slot status, session load options, and advanced server options with explicit configured values start expanded. Unconfigured advanced options, raw data, diagnostic logs, reference defaults and long examples stay collapsed. Menus and popovers retain their existing behavior. The shared model-settings dialog follows this selective rule in every workspace.

Treat expansion as an initial presentation choice. Background refreshes and edits must preserve the reader's manual collapse or expansion instead of toggling a section when its value changes.

## Terminology

Use the same localized term for the same concept across controls, result tables, explanations, sharing and exports. Reuse existing copy instead of adding a second translation in an exporter or summary. Different concepts retain distinct names: configured repetitions, collected samples, concurrent requests and total trials are not interchangeable.

Inference phase names live in `src/shared/i18n/inferenceMetricCopy.ts`: **Input processing (Prefill / PP)** and **Output generation (Decode / TG)**. Benchmark PP retains its **estimated** qualifier because it uses client-observed first-token timing. Chat retains its cached-token and reasoning-token qualifiers. Use **Rate** for per-phase speed and **Total throughput** for output tokens divided by the entire request duration. Rates use `tok/s`, durations use `s` or `ms`, and token counts are labelled separately. Keep protocol keys and saved measurements unchanged when adjusting display text.
