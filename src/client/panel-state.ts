import { STORAGE_KEYS, getStorageItem, setStorageItem, removeStorageItem } from './storage.js';

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export const CORNERS: readonly Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

export interface PanelState {
  position: Corner;
  autoHide: boolean;
  hidden: boolean;
}

export interface PanelStateController {
  getState(): PanelState;
  setPosition(corner: Corner): void;
  setAutoHide(on: boolean): void;
  setHidden(on: boolean): void;
  /** Clear all persisted overrides and re-resolve from the server-rendered config. */
  reset(): void;
  onChange(cb: (state: PanelState) => void): void;
}

const POSITION_CLASS_PREFIX = 'pp-dev-info--';
const AUTO_HIDE_CLASS = 'pp-dev-info--auto-hide';
const HIDDEN_CLASS = 'pp-dev-info--hidden';
const CLOSED_CLASS = 'closed';
const NO_TRANSITION_CLASS = 'is-dragging';

export function isCorner(value: unknown): value is Corner {
  return typeof value === 'string' && (CORNERS as readonly string[]).includes(value);
}

function stateFromDataAttrs($panel: HTMLElement): PanelState {
  return {
    position: isCorner($panel.dataset.position) ? $panel.dataset.position : 'bottom-right',
    autoHide: $panel.dataset.autoHide === 'true',
    hidden: $panel.dataset.hidden === 'true',
  };
}

/**
 * Resolve the effective panel state. Precedence per setting:
 * localStorage (runtime user choice) → data-* attribute (config) → built-in default.
 * The `?pp-dev-panel=show|hide` URL param writes a persistent localStorage override
 * before resolution, so it both restores a hidden panel and survives reloads.
 */
export function resolvePanelState($panel: HTMLElement): PanelState {
  const param = new URLSearchParams(window.location.search).get('pp-dev-panel');

  if (param === 'show') {
    setStorageItem(STORAGE_KEYS.hidden, 'false');
  } else if (param === 'hide') {
    setStorageItem(STORAGE_KEYS.hidden, 'true');
  }

  const defaults = stateFromDataAttrs($panel);

  const storedPosition = getStorageItem(STORAGE_KEYS.position);
  const storedAutoHide = getStorageItem(STORAGE_KEYS.autoHide);
  const storedHidden = getStorageItem(STORAGE_KEYS.hidden);

  return {
    position: isCorner(storedPosition) ? storedPosition : defaults.position,
    autoHide: storedAutoHide !== null ? storedAutoHide === 'true' : defaults.autoHide,
    hidden: storedHidden !== null ? storedHidden === 'true' : defaults.hidden,
  };
}

export function applyPanelState($panel: HTMLElement, state: PanelState, opts?: { instant?: boolean }): void {
  const apply = () => {
    for (const corner of CORNERS) {
      $panel.classList.toggle(POSITION_CLASS_PREFIX + corner, corner === state.position);
    }

    $panel.classList.toggle(AUTO_HIDE_CLASS, state.autoHide);
    $panel.classList.toggle(HIDDEN_CLASS, state.hidden);
  };

  if (opts?.instant) {
    // No-transition guard: when localStorage differs from the server-rendered corner,
    // the panel must not visibly slide across the screen on load. `is-dragging`
    // disables transitions; a reflow makes the class swap land before it is removed.
    $panel.classList.add(NO_TRANSITION_CLASS);
    apply();
    void $panel.offsetWidth;

    const unlock = () => $panel.classList.remove(NO_TRANSITION_CLASS);

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(unlock);
    } else {
      setTimeout(unlock, 0);
    }
  } else {
    apply();
  }
}

function clearClosed($panel: HTMLElement): void {
  $panel.classList.remove(CLOSED_CLASS);
  $panel.querySelector('.pp-dev-info__wrap-btn svg')?.classList.remove(CLOSED_CLASS);
  removeStorageItem(STORAGE_KEYS.closed);
}

export function createPanelStateController($panel: HTMLElement): PanelStateController {
  let state = resolvePanelState($panel);
  const listeners: Array<(s: PanelState) => void> = [];

  if (state.autoHide) {
    // Auto-hide and minimize are mutually exclusive; a stale persisted `closed`
    // state must not combine with the auto-hide transform.
    clearClosed($panel);
  }

  applyPanelState($panel, state, { instant: true });

  const commit = () => {
    applyPanelState($panel, state);

    for (const cb of listeners) {
      cb(state);
    }
  };

  return {
    getState: () => state,

    setPosition(corner) {
      state = { ...state, position: corner };
      setStorageItem(STORAGE_KEYS.position, corner);
      commit();
    },

    setAutoHide(on) {
      state = { ...state, autoHide: on };
      setStorageItem(STORAGE_KEYS.autoHide, String(on));

      if (on) {
        clearClosed($panel);
      }

      commit();
    },

    setHidden(on) {
      state = { ...state, hidden: on };
      setStorageItem(STORAGE_KEYS.hidden, String(on));
      commit();
    },

    reset() {
      removeStorageItem(STORAGE_KEYS.position);
      removeStorageItem(STORAGE_KEYS.autoHide);
      removeStorageItem(STORAGE_KEYS.hidden);
      clearClosed($panel);

      // Re-resolve purely from the server-rendered config (bypass the URL param,
      // which would immediately re-write its localStorage override).
      state = stateFromDataAttrs($panel);
      commit();
    },

    onChange(cb) {
      listeners.push(cb);
    },
  };
}
