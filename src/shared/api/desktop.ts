import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke, withNativeRuntime, type UnlistenFn } from './transport.ts';
import type { MigratedPath } from '../storage/storageMigration.ts';

export const migrationPaths = (): Promise<MigratedPath[]> => invoke<MigratedPath[]>('migration_paths');
export type WindowChrome = 'frameless' | 'overlay' | 'native';
export type WindowTheme = 'light' | 'dark' | null;

export interface FrameWindow {
  chrome: WindowChrome;
  window: {
    isMaximized(): Promise<boolean>;
    onResized(callback: () => void): Promise<UnlistenFn>;
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
  };
  setTheme(theme: WindowTheme): Promise<void>;
}

export async function frameWindow(): Promise<FrameWindow> {
  const chrome = await invoke<WindowChrome>('window_chrome');
  const window = getCurrentWindow();
  return {
    chrome,
    window: {
      isMaximized: () => withNativeRuntime(() => window.isMaximized()),
      onResized: callback => withNativeRuntime(() => window.onResized(callback)),
      minimize: () => withNativeRuntime(() => window.minimize()),
      toggleMaximize: () => withNativeRuntime(() => window.toggleMaximize()),
      close: () => withNativeRuntime(() => window.close()),
    },
    // Linux needs the native System policy rather than tao's setTheme(null).
    setTheme: theme => invoke<void>('window_theme', { theme }),
  };
}
