import { useEffect, useId, useRef, useState } from 'react';
import { adapterSetupCancel, adapterSetupImport, adapterSetupList, adapterSetupPrepare, pickRuntimePath,
  type AdapterSetupRecipe, type EntrypointDraft } from '../../shared/api/runtimeHelp';
import { useI18n } from '../../shared/i18n/i18n';
import { adapterSetupCopy } from '../../shared/i18n/adapterSetupCopy';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { LocalTaskCancelButton } from '../../shared/ui/TaskCancellation';
import { finishTask, registerTask, updateTask } from '../../shared/state/taskRegistry';

/** Recipe fields and commands are data. All engines return the same draft
 * and proceed through the existing explicit help/bindings/probe journey. */
export default function AdapterSetupPanel({ disabled, onBusyChange, onPrepared }: {
  disabled: boolean; onBusyChange: (busy: boolean) => void; onPrepared: (draft: EntrypointDraft) => void;
}) {
  const { locale } = useI18n();
  const copy = adapterSetupCopy[locale];
  const id = useId();
  const owner = `adapter-setup-${id}`;
  const [recipes, setRecipes] = useState<AdapterSetupRecipe[]>([]);
  const [selected, setSelected] = useState('');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const cancelled = useRef(false);
  const running = useRef(false);
  const recipe = recipes.find(item => item.id === selected);
  useEffect(() => () => {
    generation.current += 1;
    if (running.current) {
      void adapterSetupCancel(owner).catch(() => undefined);
      finishTask(owner, 'cancelled');
    }
    onBusyChange(false);
  }, [onBusyChange, owner]);
  const select = (next: AdapterSetupRecipe) => {
    setSelected(next.id);
    setInputs(Object.fromEntries(next.fields.map(field => [field.key, field.default ?? ''])));
    setError('');
  };
  const load = async (imported: boolean) => {
    const own = ++generation.current;
    setBusy(true); onBusyChange(true); setError('');
    try {
      const path = imported ? await pickRuntimePath('file') : null;
      if (imported && !path) return;
      const next = imported ? [await adapterSetupImport(path!)] : await adapterSetupList();
      if (generation.current !== own) return;
      setRecipes(next);
      if (next[0]) select(next[0]);
    } catch (cause) {
      if (generation.current === own) setError(String(cause));
    } finally {
      if (generation.current === own) { setBusy(false); onBusyChange(false); }
    }
  };
  const prepare = async () => {
    if (!recipe || busy || disabled) return;
    const own = ++generation.current;
    cancelled.current = false;
    running.current = true;
    setBusy(true); setPreparing(true); onBusyChange(true); setError('');
    registerTask({ id: owner, kind: 'runtime', label: copy.title, interruptible: true, cancel: () => {
      cancelled.current = true; void adapterSetupCancel(owner);
    } });
    try {
      const draft = await adapterSetupPrepare(owner, recipe, inputs);
      if (generation.current !== own) return;
      running.current = false;
      finishTask(owner, cancelled.current ? 'cancelled' : 'completed');
      if (!cancelled.current) onPrepared(draft);
    } catch (cause) {
      if (generation.current !== own) return;
      if (!cancelled.current) setError(String(cause));
      finishTask(owner, cancelled.current ? 'cancelled' : 'failed', String(cause));
    } finally {
      if (generation.current === own) { running.current = false; setBusy(false); setPreparing(false); onBusyChange(false); }
    }
  };
  const pick = async (field: AdapterSetupRecipe['fields'][number]) => {
    const own = ++generation.current;
    setBusy(true); onBusyChange(true); setError('');
    try {
      const path = await pickRuntimePath(field.kind as 'file' | 'folder');
      if (generation.current === own && path) setInputs(current => ({ ...current, [field.key]: path }));
    } catch (cause) {
      if (generation.current === own) setError(String(cause));
    } finally {
      if (generation.current === own) { setBusy(false); onBusyChange(false); }
    }
  };
  const locked = disabled || busy;
  return <section aria-labelledby={`${id}-title`} className="mb-4">
    <h4 id={`${id}-title`} className="app-section-title">{copy.title}</h4>
    <p className="app-section-hint">{copy.hint}</p>
    <div className="app-page-actions">
      <button type="button" className="app-button app-button--secondary" disabled={locked} onClick={() => void load(false)}>{copy.provided}</button>
      <button type="button" className="app-button app-button--secondary" disabled={locked} onClick={() => void load(true)}>{copy.import}</button>
    </div>
    {recipe && <form action="#" method="POST" className="model-settings-fields" onSubmit={event => { event.preventDefault(); void prepare(); }}>
      <CustomSelect ariaLabel={copy.select} value={selected} disabled={locked} options={recipes.map(item => ({ value: item.id, label: item.title }))}
        onChange={value => { const next = recipes.find(item => item.id === value); if (next) select(next); }} />
      <p>{recipe.description}</p>
      <fieldset disabled={locked}>
        <legend>{copy.empty}</legend>
        {recipe.fields.map(field => <span className="entrypoint-path" key={field.key}>
          <label htmlFor={`${id}-${field.key}`}>{field.label}{field.required ? ` (${copy.required})` : ''}</label>
          <input id={`${id}-${field.key}`} name={field.key} className="app-input" value={inputs[field.key] ?? ''} required={field.required}
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} maxLength={32768}
            onChange={event => setInputs(current => ({ ...current, [field.key]: event.target.value }))} />
          {field.kind !== 'text' && <button type="button" className="app-button app-button--secondary" onClick={() => void pick(field)}>{copy.choose}</button>}
        </span>)}
      </fieldset>
      <p className="app-section-hint">{copy.review}</p>
      <details><summary>{copy.command}</summary><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(recipe.prepare, null, 2)}</pre></details>
      <div className="app-page-actions">
        <button type="submit" className="app-button app-button--primary" disabled={locked}>{copy.prepare}</button>
        {preparing && <LocalTaskCancelButton taskId={owner} onClick={() => {
          cancelled.current = true; updateTask(owner, { state: 'cancelling' });
          void adapterSetupCancel(owner).catch(cause => setError(String(cause)));
        }}>{copy.cancel}</LocalTaskCancelButton>}
      </div>
    </form>}
    {error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
  </section>;
}
