import { invoke, listen, type UnlistenFn } from './transport.ts';
export interface AppUpdateInfo {
  current_version: string;
  latest_version: string | null;
  available: boolean;
  can_install: boolean;
  release_url: string | null;
  published_at: string | null;
  notes: string | null;
}

export interface AppUpdateProgress {
  phase: "downloading" | "verifying" | "installing";
  downloaded: number;
  total: number | null;
}

export const checkAppUpdate = (): Promise<AppUpdateInfo> => invoke<AppUpdateInfo>('check_app_update');
export const installAppUpdate = (version: string): Promise<void> => invoke<void>('install_app_update', { version });
export const onAppUpdateProgress = (callback: (progress: AppUpdateProgress) => void): Promise<UnlistenFn> =>
  listen<AppUpdateProgress>('app-update-progress', event => callback(event.payload));
export const openAppUpdateRelease = (): Promise<void> => invoke<void>('open_app_update_release');
