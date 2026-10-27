import { runtimeLabel, type RuntimeInstance } from '../api/providers';
import type { Locale } from './i18nCatalog';

const copy = {
  en: { managed: 'Installed by AioLM', external: 'Registered installation', unknown: 'Accelerator not checked' },
  ko: { managed: 'AioLM에서 설치', external: '직접 등록한 설치본', unknown: '가속 장치 미확인' },
  ja: { managed: 'AioLMでインストール', external: '登録したインストール先', unknown: 'アクセラレーター未確認' },
  zh: { managed: '由AioLM安装', external: '已注册的安装', unknown: '加速设备未检查' },
};

/** Translate known inventory markers without changing engine names or API data. */
export function runtimeInstanceLabel(runtime: RuntimeInstance, locale: Locale): string {
  const text = copy[locale];
  return runtimeLabel({
    ...runtime,
    installation: runtime.installation === 'managed' ? text.managed : runtime.installation === 'external' ? text.external : runtime.installation,
    accelerator: runtime.accelerator === '' || runtime.accelerator === 'unverified' || runtime.accelerator === 'unknown' ? text.unknown : runtime.accelerator,
  });
}
