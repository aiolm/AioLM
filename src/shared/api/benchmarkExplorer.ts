import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from './transport';

export const openAiolmWebsite = (locale: string) => invoke<void>('open_aiolm_website', { locale });
export const openBenchmarkExplorer = (locale: string, importLabel: string, importHint: string) =>
  invoke<void>('open_benchmark_explorer', { locale, importLabel, importHint });
export const readPublicBenchmark = (id: string) => invoke<unknown>('read_public_benchmark', { id });
export const onBenchmarkProfileImport = (callback: (id: string) => void): Promise<UnlistenFn> =>
  listen<string>('benchmark-profile-import', event => callback(event.payload));
