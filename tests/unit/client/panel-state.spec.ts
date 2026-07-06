// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolvePanelState,
  applyPanelState,
  createPanelStateController,
  CORNERS,
} from '../../../src/client/panel-state.js';
import { STORAGE_KEYS } from '../../../src/client/storage.js';

function makePanel(attrs: { position?: string; autoHide?: string; hidden?: string } = {}): HTMLElement {
  const $panel = document.createElement('div');

  $panel.className = 'pp-dev-info-namespace pp-dev-info';
  $panel.dataset.position = attrs.position ?? 'bottom-right';
  $panel.dataset.autoHide = attrs.autoHide ?? 'false';
  $panel.dataset.hidden = attrs.hidden ?? 'false';

  const $btn = document.createElement('div');

  $btn.className = 'pp-dev-info__wrap-btn';
  $btn.innerHTML = '<svg></svg>';
  $panel.appendChild($btn);
  document.body.appendChild($panel);

  return $panel;
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
});

describe('resolvePanelState — precedence', () => {
  it('uses data attributes (config) when localStorage is empty', () => {
    const $panel = makePanel({ position: 'top-left', autoHide: 'true', hidden: 'true' });

    expect(resolvePanelState($panel)).toEqual({ position: 'top-left', autoHide: true, hidden: true });
  });

  it('localStorage overrides data attributes', () => {
    const $panel = makePanel({ position: 'top-left', autoHide: 'true', hidden: 'true' });

    localStorage.setItem(STORAGE_KEYS.position, 'bottom-left');
    localStorage.setItem(STORAGE_KEYS.autoHide, 'false');
    localStorage.setItem(STORAGE_KEYS.hidden, 'false');

    expect(resolvePanelState($panel)).toEqual({ position: 'bottom-left', autoHide: false, hidden: false });
  });

  it('ignores an invalid stored position and falls back to config', () => {
    const $panel = makePanel({ position: 'top-right' });

    localStorage.setItem(STORAGE_KEYS.position, 'middle-of-nowhere');

    expect(resolvePanelState($panel).position).toBe('top-right');
  });

  it('falls back to bottom-right when both storage and data attribute are invalid', () => {
    const $panel = makePanel();

    $panel.dataset.position = 'sideways';

    expect(resolvePanelState($panel).position).toBe('bottom-right');
  });
});

describe('resolvePanelState — URL param', () => {
  it('?pp-dev-panel=show clears hidden and wins over config hidden=true', () => {
    history.replaceState(null, '', '/?pp-dev-panel=show');

    const $panel = makePanel({ hidden: 'true' });

    expect(resolvePanelState($panel).hidden).toBe(false);
    // persists as an explicit override
    expect(localStorage.getItem(STORAGE_KEYS.hidden)).toBe('false');
  });

  it('?pp-dev-panel=show wins over a stored hidden=true', () => {
    history.replaceState(null, '', '/?pp-dev-panel=show');
    localStorage.setItem(STORAGE_KEYS.hidden, 'true');

    const $panel = makePanel();

    expect(resolvePanelState($panel).hidden).toBe(false);
  });

  it('?pp-dev-panel=hide sets hidden persistently', () => {
    history.replaceState(null, '', '/?pp-dev-panel=hide');

    const $panel = makePanel();

    expect(resolvePanelState($panel).hidden).toBe(true);
    expect(localStorage.getItem(STORAGE_KEYS.hidden)).toBe('true');
  });
});

describe('applyPanelState', () => {
  it('swaps corner classes exclusively', () => {
    const $panel = makePanel();

    applyPanelState($panel, { position: 'top-left', autoHide: false, hidden: false });
    expect($panel.classList.contains('pp-dev-info--top-left')).toBe(true);

    applyPanelState($panel, { position: 'bottom-right', autoHide: false, hidden: false });
    expect($panel.classList.contains('pp-dev-info--bottom-right')).toBe(true);

    for (const corner of CORNERS.filter((c) => c !== 'bottom-right')) {
      expect($panel.classList.contains(`pp-dev-info--${corner}`)).toBe(false);
    }
  });

  it('toggles auto-hide and hidden classes', () => {
    const $panel = makePanel();

    applyPanelState($panel, { position: 'bottom-right', autoHide: true, hidden: true });
    expect($panel.classList.contains('pp-dev-info--auto-hide')).toBe(true);
    expect($panel.classList.contains('pp-dev-info--hidden')).toBe(true);

    applyPanelState($panel, { position: 'bottom-right', autoHide: false, hidden: false });
    expect($panel.classList.contains('pp-dev-info--auto-hide')).toBe(false);
    expect($panel.classList.contains('pp-dev-info--hidden')).toBe(false);
  });
});

describe('createPanelStateController', () => {
  it('setPosition persists and re-applies classes', () => {
    const $panel = makePanel();
    const controller = createPanelStateController($panel);

    controller.setPosition('top-right');

    expect(localStorage.getItem(STORAGE_KEYS.position)).toBe('top-right');
    expect($panel.classList.contains('pp-dev-info--top-right')).toBe(true);
    expect(controller.getState().position).toBe('top-right');
  });

  it('setAutoHide(true) clears the minimized (closed) state and its storage key', () => {
    const $panel = makePanel();

    $panel.classList.add('closed');
    $panel.querySelector('svg')!.classList.add('closed');
    localStorage.setItem(STORAGE_KEYS.closed, 'true');

    const controller = createPanelStateController($panel);

    controller.setAutoHide(true);

    expect($panel.classList.contains('closed')).toBe(false);
    expect($panel.querySelector('svg')!.classList.contains('closed')).toBe(false);
    expect(localStorage.getItem(STORAGE_KEYS.closed)).toBeNull();
    expect($panel.classList.contains('pp-dev-info--auto-hide')).toBe(true);
  });

  it('config-driven auto-hide clears a stale persisted closed state on init', () => {
    localStorage.setItem(STORAGE_KEYS.closed, 'true');

    const $panel = makePanel({ autoHide: 'true' });

    createPanelStateController($panel);

    expect(localStorage.getItem(STORAGE_KEYS.closed)).toBeNull();
    expect($panel.classList.contains('pp-dev-info--auto-hide')).toBe(true);
  });

  it('setHidden persists and applies the hidden class', () => {
    const $panel = makePanel();
    const controller = createPanelStateController($panel);

    controller.setHidden(true);

    expect(localStorage.getItem(STORAGE_KEYS.hidden)).toBe('true');
    expect($panel.classList.contains('pp-dev-info--hidden')).toBe(true);
  });

  it('reset clears overrides and re-resolves from data attributes', () => {
    const $panel = makePanel({ position: 'top-left' });
    const controller = createPanelStateController($panel);

    controller.setPosition('bottom-left');
    controller.setAutoHide(true);
    controller.setHidden(true);

    controller.reset();

    expect(localStorage.getItem(STORAGE_KEYS.position)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.autoHide)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.hidden)).toBeNull();
    expect(controller.getState()).toEqual({ position: 'top-left', autoHide: false, hidden: false });
    expect($panel.classList.contains('pp-dev-info--top-left')).toBe(true);
    expect($panel.classList.contains('pp-dev-info--hidden')).toBe(false);
  });

  it('notifies onChange listeners with the new state', () => {
    const $panel = makePanel();
    const controller = createPanelStateController($panel);
    const seen: string[] = [];

    controller.onChange((state) => seen.push(state.position));
    controller.setPosition('top-left');

    expect(seen).toEqual(['top-left']);
  });
});
