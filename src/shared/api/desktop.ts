import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke, withNativeRuntime, type UnlistenFn } from './transport.ts';
import type { MigratedPath } from '../storage/storageMigration.ts';

export const migrationPaths = (): Promise<MigratedPath[]> => invoke<MigratedPath[]>('migration_paths');
export type WindowChrome = 'frameless' | 'overlay' | 'native';
export type WindowTheme = 'light' | 'dark' | null;

export interface WindowIdentity {
  productName: string;
  isolatedDev: boolean;
}

export interface FrameWindow {
  chrome: WindowChrome;
  identity?: WindowIdentity;
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
  const [chrome, identity] = await Promise.all([
    invoke<WindowChrome>('window_chrome'),
    invoke<WindowIdentity>('window_identity').catch(() => undefined),
  ]);
  const window = getCurrentWindow();
  return {
    chrome,
    identity,
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
