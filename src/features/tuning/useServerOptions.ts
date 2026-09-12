import { useEffect, useMemo, useState } from 'react';
import { rtProbe } from '../../shared/api/index';
import { parseRuntimeHelp, SERVER_OPTIONS } from '../../shared/config/serverOptions';
import type { RuntimeCapabilities } from '../../shared/api/types';

export function useServerOptions(backend: string, build: string, enabled = true) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ key: string; help: string; error: string; loading: boolean; capabilities?: RuntimeCapabilities }>();
  const key = `${backend}/${build}`;
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setResult(previous => ({ ...(previous?.key === key ? previous : { key, help: '' }), error: '', loading: true }));
    void rtProbe(backend, build).then(value => {
      if (!active) return;
      const help = value.server_help ?? '';
      setResult({ key, help, error: parseRuntimeHelp(help).length ? '' : value.diagnostics.join('\n'), loading: false, capabilities: value });
    }).catch(error => {
      if (active) setResult(previous => ({ ...(previous?.key === key ? previous : { key, help: '' }), error: String(error), loading: false }));
    });
    return () => { active = false; };
  }, [backend, build, key, revision, enabled]);
  const current = result?.key === key ? result : undefined;
  const catalog = useMemo(() => {
    const parsed = parseRuntimeHelp(current?.help ?? '');
    return { options: parsed.length ? parsed : SERVER_OPTIONS, verified: parsed.length > 0 };
  }, [current?.help]);
  return { ...catalog, loading: current?.loading ?? true, error: current?.error, capabilities: current?.capabilities, refresh: () => setRevision(value => value + 1) };
}
