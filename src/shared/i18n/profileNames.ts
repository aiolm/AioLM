import { DEFAULT_SETTINGS_PROFILE_ID, type SettingsProfile } from '../config/settingsProfiles';
import type { Locale } from './i18n';

const defaultNames: Record<Locale, string> = { en: 'Default', ko: '기본', ja: 'デフォルト', zh: '默认' };
const recoveredNames: Record<Locale, string> = { en: 'Recovered profile', ko: '기존 설정', ja: '既存の設定', zh: '原有设置' };

/** Only the original default name is translated; user-assigned names are retained. */
export function profileDisplayName(profile: Pick<SettingsProfile, 'id' | 'name' | 'source_id'>, locale: Locale): string {
  if (profile.id.startsWith('profile-recovered-') && profile.name === 'Recovered profile') return recoveredNames[locale];
  return (profile.id === DEFAULT_SETTINGS_PROFILE_ID || profile.source_id === DEFAULT_SETTINGS_PROFILE_ID) && profile.name === 'Default'
    ? defaultNames[locale] : profile.name;
}
