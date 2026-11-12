import { invoke } from './transport.ts';

export type NativeNotificationPermission = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale';
export interface DesktopNotification { title: string; body: string }

export const notificationPermissionGranted = (): Promise<boolean | null> =>
  invoke<boolean | null>('plugin:notification|is_permission_granted');
export const notificationRequestPermission = (): Promise<NativeNotificationPermission> =>
  invoke<NativeNotificationPermission>('plugin:notification|request_permission');
export const sendDesktopNotification = (options: DesktopNotification): Promise<void> =>
  invoke<void>('send_desktop_notification', { options });
