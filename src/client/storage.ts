// localStorage helpers guarded against environments where storage is unavailable
// (e.g. sandboxed iframes). Keys follow the original `pp-dev-info-closed` naming.

export const STORAGE_KEYS = {
  closed: 'pp-dev-info-closed',
  position: 'pp-dev-info-position',
  autoHide: 'pp-dev-info-auto-hide',
  hidden: 'pp-dev-info-hidden',
} as const;

export function checkLocalStorage() {
  try {
    localStorage.setItem('test', 'test');
    localStorage.removeItem('test');

    return true;
  } catch (e) {
    return false;
  }
}

export function setStorageItem(key: string, value: string) {
  if (checkLocalStorage()) {
    localStorage.setItem(key, value);
  }
}

export function getStorageItem(key: string) {
  if (checkLocalStorage()) {
    return localStorage.getItem(key);
  }

  return null;
}

export function removeStorageItem(key: string) {
  if (checkLocalStorage()) {
    localStorage.removeItem(key);
  }
}
