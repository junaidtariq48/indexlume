'use client';

export type NotificationType = 'success' | 'error' | 'warning' | 'info';

export interface ToastNotification {
  message: string;
  type: NotificationType;
}

export function notify(message: string, type: NotificationType = 'success') {
  window.dispatchEvent(
    new CustomEvent<ToastNotification>('osc-toast', {
      detail: { message, type },
    }),
  );
}
