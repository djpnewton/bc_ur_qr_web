export type ToastKind = 'info' | 'ok' | 'warn' | 'error';

let host: HTMLElement | null = null;

function getHost(): HTMLElement | null {
  if (!host) host = document.getElementById('toasts');
  return host;
}

export function toast(message: string, kind: ToastKind = 'info', durationMs = 3600): void {
  const parent = getHost();
  if (!parent) return;

  const element = document.createElement('div');
  element.className = kind === 'info' ? 'toast' : `toast ${kind}`;
  element.textContent = message;
  parent.append(element);

  window.setTimeout(() => {
    element.classList.add('leaving');
    window.setTimeout(() => element.remove(), 260);
  }, durationMs);
}
