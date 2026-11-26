import { useState } from 'react';
import type { CommandSyntax } from '../api/runtimeHelp';
import { commandImportCopy } from '../i18n/commandImportCopy';
import { useI18n } from '../i18n/i18n';
import { commandLineWarning, formatCommandLine, hostCommandLineSyntax } from '../lib/commandLine';
import { stripWindowsVerbatimPrefixArg } from '../lib/displayPaths';
import CopyTextButton from './CopyTextButton';
import { CustomSelect } from './CustomSelect';
import FeedbackBanner from './FeedbackBanner';
import './CommandLineViewer.css';

export type CommandLineKind = 'engine' | 'aiolm';

export interface CommandLineViewerLabels {
  copy: string;
  copied: string;
  copyFailed: string;
  format: string;
  kind: string;
  kindEngine: string;
  kindAiolm: string;
  kindEngineHint: string;
  kindAiolmHint: string;
  recordedKindEngineHint?: string;
  recordedKindAiolmHint?: string;
  /** Shown under a recorded engine command whose port binding stayed `{port}`. */
  recordedPortHint?: string;
  multiline: string;
  maskedHint: string;
  launchBlocked: string;
  environmentExpands: string;
  newlineBreaks: string;
}

const MASKED_BULLET_PLACEHOLDER = '•••';
const RECORDED_PORT_PLACEHOLDER = '{port}';

export interface CommandLineViewerProps {
  argv: readonly string[];
  engineArgv?: readonly string[];
  blocked?: string;
  context?: 'preview' | 'recorded';
  framed?: boolean;
  labels: CommandLineViewerLabels;
  commandKind?: CommandLineKind;
  onCommandKindChange?: (kind: CommandLineKind) => void;
  syntax?: CommandSyntax;
  onSyntaxChange?: (syntax: CommandSyntax) => void;
  multiline?: boolean;
  onMultilineChange?: (multiline: boolean) => void;
  className?: string;
}

/**
 * Interactive shell command display with engine/helper toggle, quoting syntax
 * selector, per-option line breaks, clipboard copy, secret notice, and cmd.exe
 * hazard warnings.
 */
export default function CommandLineViewer({
  argv,
  engineArgv,
  blocked,
  context = 'preview',
  framed = true,
  labels,
  commandKind: controlledKind,
  onCommandKindChange,
  syntax: controlledSyntax,
  onSyntaxChange,
  multiline: controlledMultiline,
  onMultilineChange,
  className,
}: CommandLineViewerProps) {
  const { locale } = useI18n();
  const [uncontrolledKind, setUncontrolledKind] = useState<CommandLineKind>('engine');
  const [uncontrolledSyntax, setUncontrolledSyntax] = useState<CommandSyntax>(hostCommandLineSyntax);
  const [uncontrolledMultiline, setUncontrolledMultiline] = useState(true);

  const activeKind = controlledKind ?? uncontrolledKind;
  const activeSyntax = controlledSyntax ?? uncontrolledSyntax;
  const activeMultiline = controlledMultiline ?? uncontrolledMultiline;
  const setKind = onCommandKindChange ?? setUncontrolledKind;
  const setSyntax = onSyntaxChange ?? setUncontrolledSyntax;
  const setMultiline = onMultilineChange ?? setUncontrolledMultiline;

  const cleanArgv = argv.map(stripWindowsVerbatimPrefixArg);
  const cleanEngineArgv = engineArgv?.map(stripWindowsVerbatimPrefixArg) ?? [];
  const hasEngine = cleanEngineArgv.length > 0;
  const shownArgv = activeKind === 'engine' && hasEngine ? cleanEngineArgv : cleanArgv;
  if (!shownArgv.length) return null;

  const formatted = formatCommandLine(shownArgv, activeSyntax, { multiline: activeMultiline });
  if (!formatted) return null;

  const hasMaskedSecrets = shownArgv.some(
    arg => arg.includes(MASKED_BULLET_PLACEHOLDER) || /\[redacted\]/i.test(arg),
  );
  const warning = commandLineWarning(shownArgv, activeSyntax);
  // Benchmark records keep the engine's port binding unresolved: the helper
  // chose that port at launch and never reported it.
  const portPlaceholder = context === 'recorded' && hasEngine && activeKind === 'engine'
    && shownArgv.some(arg => arg === RECORDED_PORT_PLACEHOLDER || arg.endsWith(`=${RECORDED_PORT_PLACEHOLDER}`));
  const syntaxCopy = commandImportCopy[locale];
  const syntaxOptions = [
    { value: 'powershell' as const, label: syntaxCopy.powershell },
    { value: 'windows' as const, label: syntaxCopy.windows },
    { value: 'posix' as const, label: syntaxCopy.posix },
  ];
  const engineHint = hasEngine
    ? context === 'recorded'
      ? activeKind === 'engine'
        ? (labels.recordedKindEngineHint ?? labels.kindEngineHint)
        : (labels.recordedKindAiolmHint ?? labels.kindAiolmHint)
      : activeKind === 'engine'
        ? labels.kindEngineHint
        : labels.kindAiolmHint
    : null;

  const rootClassName = [
    'command-line-viewer',
    framed ? 'command-line-viewer__block model-settings-command-preview-block' : 'command-line-viewer__body',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClassName}>
      <div className="command-line-viewer__controls model-settings-command-controls">
        {hasEngine && (
          <label className="command-line-viewer__select command-line-viewer__select--wide">
            <span>{labels.kind}</span>
            <CustomSelect<CommandLineKind>
              size="sm"
              ariaLabel={labels.kind}
              value={activeKind}
              options={[
                { value: 'engine', label: labels.kindEngine },
                { value: 'aiolm', label: labels.kindAiolm },
              ]}
              onChange={setKind}
            />
          </label>
        )}
        <label className="command-line-viewer__select">
          <span>{labels.format}</span>
          <CustomSelect<CommandSyntax>
            size="sm"
            ariaLabel={labels.format}
            value={activeSyntax}
            options={syntaxOptions}
            onChange={setSyntax}
          />
        </label>
        <label className="command-line-viewer__check model-settings-command-check">
          <input
            type="checkbox"
            className="command-line-viewer__checkbox model-settings-checkbox"
            checked={activeMultiline}
            onChange={event => setMultiline(event.target.checked)}
          />
          <span>{labels.multiline}</span>
        </label>
        <CopyTextButton
          text={formatted}
          labels={labels}
          className="command-line-viewer__copy model-settings-command-copy"
        />
      </div>
      <pre className="command-line-viewer__pre model-settings-command-preview overflow-auto whitespace-pre-wrap">
        {formatted}
      </pre>
      {engineHint && <p className="app-section-hint">{engineHint}</p>}
      {portPlaceholder && labels.recordedPortHint && <p className="app-section-hint">{labels.recordedPortHint}</p>}
      {hasMaskedSecrets && <p className="app-section-hint">{labels.maskedHint}</p>}
      {warning && (
        <FeedbackBanner tone="warning">
          {warning === 'newline' ? labels.newlineBreaks : labels.environmentExpands}
        </FeedbackBanner>
      )}
      {blocked && (
        <FeedbackBanner tone="warning">
          {labels.launchBlocked} {blocked}
        </FeedbackBanner>
      )}
    </div>
  );
}
