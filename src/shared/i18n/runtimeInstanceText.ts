import { runtimeLabel, type RuntimeInstance } from '../api/providers';
import type { Locale } from './i18nCatalog';

const copy = {
  en: { managed: 'Installed by AioLM', external: 'Registered installation', unknown: 'Accelerator not checked', automatic: 'Automatic connection' },
  ko: { managed: 'AioLM에서 설치', external: '직접 등록한 설치본', unknown: '가속 장치 미확인', automatic: '자동 연결' },
  ja: { managed: 'AioLMでインストール', external: '登録したインストール先', unknown: 'アクセラレーター未確認', automatic: '自動接続' },
  zh: { managed: '由AioLM安装', external: '已注册的安装', unknown: '加速设备未检查', automatic: '自动连接' },
};

/** Translate known inventory markers without changing engine names or API data. */
export function runtimeInstanceLabel(runtime: RuntimeInstance, locale: Locale): string {
  const text = copy[locale];
  if (runtime.connection_label != null) return runtime.connection_label.trim() || text.automatic;
  return runtimeLabel({
    ...runtime,
    installation: runtime.installation === 'managed' ? text.managed : runtime.installation === 'external' ? text.external : runtime.installation,
    accelerator: runtime.accelerator === '' || runtime.accelerator === 'unverified' || runtime.accelerator === 'unknown' ? text.unknown : runtime.accelerator,
  });
}
