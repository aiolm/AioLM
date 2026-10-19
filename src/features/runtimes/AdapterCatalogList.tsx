import { memo, useDeferredValue, useId, useMemo, useState } from 'react';
import { type ProviderDescription, type ProviderId, type RuntimeInstance } from '../../shared/api/providers';
import { runtimeInstanceLabel } from '../../shared/i18n/runtimeInstanceText';
import { useI18n } from '../../shared/i18n/i18n';
import { adapterCatalogCopy, fillAdapterCopy } from '../../shared/i18n/adapterCatalogCopy';
import Badge from '../../shared/ui/Badge';

type Copy = (typeof adapterCatalogCopy)['en'];

function AdapterRow({ item, runtimes, disabled, copy, onOpen }: {
  item: ProviderDescription; runtimes: RuntimeInstance[]; disabled: boolean; copy: Copy; onOpen: (id: ProviderId) => void;
}) {
  const { locale } = useI18n();
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const builtin = item.kind !== 'external-process';
  const attention = runtimes.some(runtime => !runtime.available);
  const state = !item.availability.supported
    ? { tone: 'warning' as const, label: copy.unsupported }
    : runtimes.length === 0
      ? { tone: 'neutral' as const, label: copy.notInstalled }
      : { tone: 'info' as const, label: fillAdapterCopy(builtin ? copy.installed : copy.registered, { count: runtimes.length }) };
  return (
    <li className="adapter-row">
      <div className="adapter-row__head">
        <button type="button" className="adapter-row__open" data-adapter={item.id} disabled={disabled}
          aria-describedby={`${id}-meta ${id}-state`} onClick={() => onOpen(item.id)}>
          <strong>{item.engine}</strong>
          <span id={`${id}-meta`} className="adapter-row__meta" aria-hidden="true">{item.managed_variant ?? item.server}</span>
        </button>
        <span id={`${id}-state`} className="adapter-row__badges">
          <Badge>{builtin ? copy.builtin : copy.custom}</Badge>{' '}
          <Badge tone={state.tone}>{state.label}</Badge>
          {attention && <>{' '}<Badge tone="warning">{copy.attention}</Badge></>}
        </span>
        <button type="button" className="app-button app-button--ghost app-button--sm" aria-expanded={expanded} aria-controls={`${id}-details`}
          onClick={() => setExpanded(value => !value)}>
          {copy.details}{' '}<span className="sr-only">{item.engine}</span>
        </button>
      </div>
      <div id={`${id}-details`} className="adapter-row__details" hidden={!expanded}>
        <p>{copy.server}: {item.server}{item.managed_version ? ` · ${item.managed_version}` : ''}</p>
        {!item.availability.supported && item.availability.detail && <p>{item.availability.detail}</p>}
        {runtimes.length === 0 ? <p>{copy.noRuntimes}</p> : (
          <ul>
            {runtimes.map(runtime => (
              <li key={runtime.id}>
                {runtimeInstanceLabel(runtime, locale)} · {runtime.available ? copy.runtimeFound : copy.attention}
                {runtime.problems.length > 0 && <small> · {runtime.problems.join('; ')}</small>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/** One neutral inventory of every adapter the backend describes: built-in
 * and registered engines are listed, searched and opened the same way.
 * Opening an adapter browses it; it never changes execution selection. */
export default memo(function AdapterCatalogList({
  catalog,
  runtimes,
  loading = false,
  disabled = false,
  onOpen,
}: {
  catalog: ProviderDescription[];
  runtimes: RuntimeInstance[];
  loading?: boolean;
  disabled?: boolean;
  onOpen: (id: ProviderId) => void;
}) {
  const { locale } = useI18n();
  const copy = adapterCatalogCopy[locale];
  const headingId = useId();
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search);
  const rows = useMemo(() => {
    const query = deferred.trim().toLowerCase();
    const runtimeByProvider = new Map<string, RuntimeInstance[]>();
    for (const runtime of runtimes) {
      runtimeByProvider.set(runtime.provider, [...(runtimeByProvider.get(runtime.provider) ?? []), runtime]);
    }
    return catalog
      .filter(item => !query || `${item.id} ${item.engine} ${item.server} ${item.managed_variant ?? ''}`.toLowerCase().includes(query))
      .map(item => ({ item, runtimes: runtimeByProvider.get(item.id) ?? [] }))
      .sort((a, b) => a.item.engine.localeCompare(b.item.engine, undefined, { sensitivity: 'base' }) || a.item.id.localeCompare(b.item.id));
  }, [catalog, runtimes, deferred]);

  return (
    <section className="app-card app-card--tight mb-4" aria-labelledby={headingId}>
      <h3 id={headingId} className="app-section-title">{copy.title}</h3>
      <label htmlFor="adapter-search">{copy.search}</label>
      <input
        id="adapter-search"
        name="adapter-search"
        className="app-input"
        type="search"
        value={search}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={event => setSearch(event.target.value)}
      />
      <p role="status" className="app-section-hint adapter-count">
        {loading ? copy.loading : fillAdapterCopy(copy.count, { shown: rows.length, total: catalog.length })}
      </p>
      <ul className="adapter-list">
        {rows.map(({ item, runtimes: owned }) => (
          <AdapterRow key={item.id} item={item} runtimes={owned} disabled={disabled} copy={copy} onOpen={onOpen} />
        ))}
      </ul>
      {!loading && rows.length === 0 && catalog.length > 0 && <p className="app-section-hint">{copy.empty}</p>}
      <p className="app-section-hint">{copy.readyNote}</p>
    </section>
  );
});
