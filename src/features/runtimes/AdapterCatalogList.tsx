import { memo, useDeferredValue, useMemo, useState } from 'react';
import type { ProviderDescription, RuntimeInstance } from '../../shared/api/providers';
import { useI18n } from '../../shared/i18n/i18n';
import { adapterCatalogCopy } from '../../shared/i18n/adapterCatalogCopy';

/** Open adapter list: installed and registered adapters with search. */
export default memo(function AdapterCatalogList({
  catalog,
  runtimes,
}: {
  catalog: ProviderDescription[];
  runtimes: RuntimeInstance[];
}) {
  const { locale } = useI18n();
  const copy = adapterCatalogCopy[locale];
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search);
  const rows = useMemo(() => {
    const query = deferred.trim().toLowerCase();
    const runtimeByProvider = new Map<string, number>();
    for (const runtime of runtimes) {
      runtimeByProvider.set(runtime.provider, (runtimeByProvider.get(runtime.provider) ?? 0) + 1);
    }
    return catalog
      .filter(item => {
        if (!query) return true;
        return `${item.id} ${item.engine} ${item.server}`.toLowerCase().includes(query);
      })
      .map(item => ({
        item,
        count: runtimeByProvider.get(item.id) ?? 0,
        builtin: item.kind !== 'external-process',
      }))
      .sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.item.id.localeCompare(b.item.id));
  }, [catalog, runtimes, deferred]);

  return (
    <section className="app-card app-card--tight mb-4" aria-label="Adapter catalog">
      <h3 className="app-section-title">{copy.journey}</h3>
      <p className="app-section-hint">{copy.hint}</p>
      <label htmlFor="adapter-search">{copy.search}</label>
      <input
        id="adapter-search"
        name="adapter-search"
        className="app-input"
        type="search"
        value={search}
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={event => setSearch(event.target.value)}
      />
      <ul>
        {rows.map(({ item, count, builtin }) => (
          <li key={item.id} style={{ contentVisibility: 'auto' }}>
            {item.engine} · {item.server} · {builtin ? copy.builtin : copy.custom} · {count} {copy.runtimes}
            {!item.availability.supported && <small> · {item.availability.detail}</small>}
          </li>
        ))}
      </ul>
      {rows.length === 0 && <p className="app-section-hint">{copy.empty}</p>}
    </section>
  );
});
