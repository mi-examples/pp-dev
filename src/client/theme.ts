// Theme override (Auto/Dark/Light), shared across the dev panel and the standalone
// Inspector/Variables Editor pages via the same localStorage key (see STORAGE_KEYS.theme) and
// the same `data-pp-dev-theme` attribute convention (prefixed to avoid colliding with a host
// Portal Page's own theme attribute, since the panel is injected into pages pp-dev doesn't own).
import { STORAGE_KEYS, getStorageItem, setStorageItem } from './storage.js';

export type ThemeChoice = 'auto' | 'dark' | 'light';

const THEME_ATTR = 'data-pp-dev-theme';

export function getStoredTheme(): ThemeChoice {
  const value = getStorageItem(STORAGE_KEYS.theme);

  return value === 'dark' || value === 'light' ? value : 'auto';
}

export function applyTheme(theme: ThemeChoice): void {
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute(THEME_ATTR, theme);
  } else {
    document.documentElement.removeAttribute(THEME_ATTR);
  }
}

export function setTheme(theme: ThemeChoice): void {
  setStorageItem(STORAGE_KEYS.theme, theme);
  applyTheme(theme);
}

/** Call once on page load to apply whatever was last chosen (defaults to 'auto', a no-op). */
export function initTheme(): void {
  applyTheme(getStoredTheme());
}
