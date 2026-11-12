import { useDeferredValue, useMemo, useState } from 'react';
import type { RuntimeOptionSchemaFormProps } from './RuntimeOptionSchemaForm';

export function useSchemaOptionPagination({ schema, filter }: Pick<RuntimeOptionSchemaFormProps, 'schema' | 'filter'>) {
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('');
  const [limit, setLimit] = useState(64);
  const deferredSearch = useDeferredValue(search);

  // Rebuilt on each render like the field list: hosts may update the same
  // schema object in place, and the category chooser must follow it.
  const groups = [...new Set(schema.options.map(option => option.group || 'runtime'))].sort();
  const visible = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    return schema.options.filter(option => {
      if (filter && !filter(option)) return false;
      if (group && (option.group || 'runtime') !== group) return false;
      if (!query) return true;
      const haystack = `${option.key} ${option.spellings.map(s => s.flag).join(' ')} ${option.help} ${option.group}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [schema, deferredSearch, group, filter]);

  const changeSearch = (next: string) => { setSearch(next); setLimit(64); };
  const changeGroup = (next: string) => { setGroup(next); setLimit(64); };
  const showMore = () => setLimit(current => current + 64);
  return { search, group, groups, limit, visible, changeSearch, changeGroup, showMore };
}
