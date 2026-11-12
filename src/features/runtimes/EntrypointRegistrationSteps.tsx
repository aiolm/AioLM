import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { LocalTaskCancelButton } from '../../shared/ui/TaskCancellation';
import RuntimeArgumentList from './RuntimeArgumentList';
import RuntimeSchemaChanges from './RuntimeSchemaChanges';
import RuntimeCommandLayout from './RuntimeCommandLayout';
import HelpTextSettings from './HelpTextSettings';
import { BindingField, PathField } from './EntrypointRegistrationFields';
import type { EntrypointRegistrationController } from './entrypointRegistrationTypes';

interface StepProps { controller: EntrypointRegistrationController }
const FORMATS = ['gguf', 'hf-safetensors', 'mlx', 'unknown'] as const;

export function EntrypointEntryStep({ controller }: StepProps) {
  const {
    id, copy, disabled, program, setProgram, prefix, setPrefix, setError, artifacts, setArtifacts,
    displayName, setDisplayName, engine, setEngine, runtime, setRuntime, workingDir, setWorkingDir,
    env, setEnv, protocol, setProtocol, bridgeProgram, setBridgeProgram, bridgePrefix, setBridgePrefix,
    bridgeArgvEnv, setBridgeArgvEnv, commandLayout, setCommandLayout, metadataText, setMetadataText, metadata,
  } = controller;
  return (
    <div className="model-settings-fields">
      <div className="entrypoint-primary">
        <h4 className="app-section-title">{copy.manual}</h4>
        <p className="app-section-hint">{copy.fileHint}</p>
        <p className="app-section-hint">{copy.requirements}</p>
        <PathField label={copy.program} value={program} kind="file" disabled={disabled} required copy={copy} onChange={setProgram} />
      </div>
      <RuntimeArgumentList label={copy.prefix} tokens={prefix} disabled={disabled} onError={setError} onChange={setPrefix}
        onFile={path => setArtifacts(current => (current.includes(path) ? current : [...current, path]))} />
      {([[copy.display, displayName, setDisplayName], [copy.engine, engine, setEngine], [copy.runtime, runtime, setRuntime]] as const).map(([label, value, set]) => (
        <label key={label} htmlFor={`${id}-${label}`}>{label}
          <input id={`${id}-${label}`} name={label} className="app-input" value={value} disabled={disabled}
            autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={event => set(event.target.value)} />
        </label>
      ))}
      <PathField label={copy.workingDir} value={workingDir} kind="folder" disabled={disabled} copy={copy} onChange={setWorkingDir} />
      <RuntimeArgumentList label={copy.artifacts} tokens={artifacts} disabled={disabled} onError={setError} onChange={setArtifacts} onFile={() => undefined} />
      <fieldset>
        <legend>{copy.environment}</legend>
        {env.map(([name, value], index) => (
          <span key={index} className="entrypoint-token">
            <input className="app-input" name={`env-name-${index}`} aria-label={`${copy.variableName} ${index + 1}`} value={name} disabled={disabled}
              autoCorrect="off" autoCapitalize="off" spellCheck={false}
              onChange={event => setEnv(env.map((pair, i) => (i === index ? [event.target.value, pair[1]] : pair)))} />
            <input className="app-input" name={`env-value-${index}`} aria-label={`${copy.variableValue} ${index + 1}`} value={value} disabled={disabled}
              autoCorrect="off" autoCapitalize="off" spellCheck={false}
              onChange={event => setEnv(env.map((pair, i) => (i === index ? [pair[0], event.target.value] : pair)))} />
            <button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={() => setEnv(env.filter((_, i) => i !== index))}>{copy.remove}</button>
          </span>
        ))}
        <button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={() => setEnv([...env, ['', '']])}>{copy.addVariable}</button>
      </fieldset>
      <fieldset>
        <legend>{copy.protocol}</legend>
        <label><input type="radio" name={`${id}-protocol`} checked={protocol === 'openai_http'} disabled={disabled} onChange={() => setProtocol('openai_http')} /> {copy.direct}</label>
        <label><input type="radio" name={`${id}-protocol`} checked={protocol === 'bridge'} disabled={disabled} onChange={() => setProtocol('bridge')} /> {copy.bridge}</label>
        {protocol === 'bridge' && (
          <>
            <PathField label={copy.bridgeProgram} value={bridgeProgram} kind="file" disabled={disabled} required copy={copy} onChange={setBridgeProgram} />
            <RuntimeArgumentList label={copy.bridgePrefix} tokens={bridgePrefix} disabled={disabled} onChange={setBridgePrefix} onError={setError}
              onFile={path => setArtifacts(current => (current.includes(path) ? current : [...current, path]))} />
            <label htmlFor={`${id}-bridge-argv-env`}>{copy.bridgeArgvEnv}
              <input id={`${id}-bridge-argv-env`} className="app-input" value={bridgeArgvEnv} disabled={disabled} required
                autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={event => setBridgeArgvEnv(event.target.value)} />
            </label>
            <p className="app-section-hint">{copy.bridgeContract}</p>
          </>
        )}
      </fieldset>
      <RuntimeCommandLayout prefix={protocol === 'bridge' ? bridgePrefix : prefix} value={commandLayout} disabled={disabled} onChange={setCommandLayout} />
      <label htmlFor={`${id}-metadata`}>{copy.optionMetadata}</label>
      <textarea id={`${id}-metadata`} name="option-metadata" className="app-textarea" value={metadataText} disabled={disabled}
        autoCorrect="off" autoCapitalize="off" spellCheck={false}
        aria-describedby={`${id}-metadata-hint${metadata.ok ? '' : ` ${id}-metadata-error`}`} aria-invalid={!metadata.ok || undefined}
        onChange={event => setMetadataText(event.target.value)} />
      <p id={`${id}-metadata-hint`} className="app-section-hint">{copy.optionMetadataHint}</p>
      {!metadata.ok && <span id={`${id}-metadata-error`} role="alert">{copy.optionMetadataInvalid}</span>}
    </div>
  );
}

export function EntrypointHelpStep({ controller }: StepProps) {
  const {
    copy, disabled, protocol, helpArgs, changeHelpArgs, textChoice, changeTextChoice,
    discover, busy, taskId, cancelHelp, setSkipHelp, found, current, skipHelp, summary,
  } = controller;
  return (
    <div className="model-settings-fields">
      {protocol === 'bridge' && <p className="app-section-hint">{copy.bridgeHelp}</p>}
      <RuntimeArgumentList label={copy.helpArgs} tokens={helpArgs} disabled={disabled} onChange={changeHelpArgs} />
      <HelpTextSettings value={textChoice} disabled={disabled} onChange={changeTextChoice} />
      <div className="app-page-actions">
        <button type="button" className="app-button app-button--primary" disabled={disabled} onClick={() => void discover()}>{copy.discover}</button>
        {busy && <LocalTaskCancelButton taskId={taskId} onClick={cancelHelp}>{copy.cancel}</LocalTaskCancelButton>}
        <button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={() => setSkipHelp(true)}>{copy.skipHelp}</button>
      </div>
      {found && !current && <FeedbackBanner tone="warning">{copy.stale}</FeedbackBanner>}
      {skipHelp && <FeedbackBanner tone="warning">{copy.helpSkipped}</FeedbackBanner>}
      {current && summary && (
        <div role="status">
          <p>{copy.discovered}: {summary.total} {copy.options}</p>
          <RuntimeSchemaChanges descriptor={current.result[1]} />
          {summary.uncertain.length > 0 && <p>{copy.uncertain}: {summary.uncertain.length} ({summary.uncertain.slice(0, 20).join(', ')}{summary.uncertain.length > 20 ? ', …' : ''})</p>}
          {!current.result[1].help_complete && <FeedbackBanner tone="error">{copy.incomplete}</FeedbackBanner>}
          <details>
            <summary>{copy.rawHelp}</summary>
            <pre className="entrypoint-raw">{[current.result[0].stdout.clean_text, current.result[0].stderr.clean_text].filter(Boolean).join('\n')}</pre>
          </details>
        </div>
      )}
    </div>
  );
}

export function EntrypointBindingsStep({ controller }: StepProps) {
  const {
    id, copy, disabled, model, setModel, port, setPort, host, setHost, served, setServed,
    documented, positionalDocumented, helpChecked, auth, setAuth, authName, setAuthName,
    probeProgram, setProbeProgram, probeArgs, setProbeArgs, healthPath, setHealthPath,
    healthAuth, setHealthAuth, formats, setFormats,
  } = controller;
  return (
    <div className="model-settings-fields">
      <BindingField label={copy.model} state={model} optional={false} documented={documented} positionalDocumented={positionalDocumented} helpChecked={helpChecked} disabled={disabled} copy={copy} onChange={setModel} />
      <BindingField label={copy.port} state={port} optional={false} documented={documented} positionalDocumented={positionalDocumented} helpChecked={helpChecked} disabled={disabled} copy={copy} onChange={setPort} />
      <BindingField label={copy.host} state={host} optional documented={documented} positionalDocumented={positionalDocumented} helpChecked={helpChecked} disabled={disabled} copy={copy} onChange={setHost} />
      <BindingField label={copy.served} state={served} optional documented={documented} positionalDocumented={positionalDocumented} helpChecked={helpChecked} disabled={disabled} copy={copy} onChange={setServed} />
      <fieldset>
        <legend>{copy.auth}</legend>
        <label><input type="radio" name={`${id}-auth`} checked={auth === 'none'} disabled={disabled} onChange={() => setAuth('none')} /> {copy.authNone}</label>
        <label><input type="radio" name={`${id}-auth`} checked={auth === 'env'} disabled={disabled} onChange={() => setAuth('env')} /> {copy.authEnv}</label>
        {auth === 'env' && (
          <label htmlFor={`${id}-auth-name`}>{copy.authName}
            <input id={`${id}-auth-name`} name="credential-variable" className="app-input" value={authName} disabled={disabled} required
              autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={event => setAuthName(event.target.value)} />
          </label>
        )}
      </fieldset>
      <fieldset>
        <legend>{copy.probe}</legend>
        <PathField label={copy.probeProgram} value={probeProgram} kind="file" disabled={disabled} required copy={copy} onChange={setProbeProgram} />
        <RuntimeArgumentList label={copy.probeArgs} tokens={probeArgs} disabled={disabled} onChange={setProbeArgs} />
        <span className="app-page-actions">
          <button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={() => setProbeArgs([...probeArgs, '{model}'])}>{copy.insertModel}</button>
          <button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={() => setProbeArgs([...probeArgs, '{options_json}'])}>{copy.insertOptions}</button>
        </span>
      </fieldset>
      <label htmlFor={`${id}-health`}>{copy.health}
        <input id={`${id}-health`} name="health-path" className="app-input" value={healthPath} disabled={disabled} required
          autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={event => setHealthPath(event.target.value)} />
      </label>
      <label><input type="checkbox" checked={healthAuth} disabled={disabled} onChange={event => setHealthAuth(event.target.checked)} /> {copy.healthAuth}</label>
      <fieldset>
        <legend>{copy.formats}</legend>
        {FORMATS.map(format => (
          <label key={format}><input type="checkbox" checked={formats.includes(format)} disabled={disabled}
            onChange={event => setFormats(event.target.checked ? [...formats, format] : formats.filter(item => item !== format))} /> {format}</label>
        ))}
      </fieldset>
    </div>
  );
}

export function EntrypointReviewStep({ controller }: StepProps) {
  const { copy, manifest, done, locked, busy, helpPending, retryHelp, register } = controller;
  return (
    <div className="entrypoint-review">
      <p className="app-section-hint">{copy.reviewHint}</p>
      {manifest && <pre className="entrypoint-review-manifest">{manifest}</pre>}
      {done ? <p role="status">{copy.registered}</p> : (
        <div className="app-page-actions">
          <button type="submit" className="app-button app-button--primary" disabled={locked} aria-disabled={locked || busy} onClick={() => void (helpPending ? retryHelp() : register())}>{helpPending ? copy.retryHelp : copy.register}</button>
        </div>
      )}
    </div>
  );
}
