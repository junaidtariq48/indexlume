'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { Button } from './ui/button';

type ThemePreference = 'light' | 'dark' | 'system';

const storageKey = 'osc-theme';
const themeEvent = 'osc-theme-change';

function readPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  const value = window.localStorage.getItem(storageKey);
  return value === 'light' || value === 'dark' || value === 'system'
    ? value
    : 'system';
}

function applyPreference(preference: ThemePreference) {
  const dark =
    preference === 'dark' ||
    (preference === 'system' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset.theme = preference;
}

function subscribe(onStoreChange: () => void) {
  window.addEventListener(themeEvent, onStoreChange);
  window.addEventListener('storage', onStoreChange);
  return () => {
    window.removeEventListener(themeEvent, onStoreChange);
    window.removeEventListener('storage', onStoreChange);
  };
}

function setPreference(preference: ThemePreference) {
  window.localStorage.setItem(storageKey, preference);
  applyPreference(preference);
  window.dispatchEvent(new Event(themeEvent));
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => applyPreference(readPreference());
    sync();
    media.addEventListener('change', sync);
    window.addEventListener('storage', sync);
    return () => {
      media.removeEventListener('change', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return children;
}

export function ThemeToggle({ className }: { className?: string }) {
  const preference = useSyncExternalStore(
    subscribe,
    readPreference,
    () => 'system',
  );
  const next: ThemePreference =
    preference === 'system'
      ? 'light'
      : preference === 'light'
        ? 'dark'
        : 'system';
  const Icon =
    preference === 'system' ? Monitor : preference === 'light' ? Sun : Moon;

  return (
    <Button
      className={className}
      onClick={() => setPreference(next)}
      size="icon"
      title={`Theme: ${preference}. Switch to ${next}.`}
      type="button"
      variant="ghost"
    >
      <Icon aria-hidden="true" className="size-4" />
      <span className="sr-only">
        Theme: {preference}. Switch to {next}.
      </span>
    </Button>
  );
}
