import { invoke, listen, type UnlistenFn } from './transport';
import type { JsonValue } from '../config/tuningValidation';

export const openAiolmWebsite = (locale: string) => invoke<void>('open_aiolm_website', { locale });
export const openBenchmarkExplorer = (locale: string, importLabel: string, importHint: string) =>
  invoke<void>('open_benchmark_explorer', { locale, importLabel, importHint });
export const readPublicBenchmark = (id: string): Promise<JsonValue> => invoke<JsonValue>('read_public_benchmark', { id });
export const onBenchmarkProfileImport = (callback: (id: string) => void): Promise<UnlistenFn> =>
  listen<string>('benchmark-profile-import', event => callback(event.payload));
