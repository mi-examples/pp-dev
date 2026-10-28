// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPopupElement, startAutoDismiss } from '../../../src/client/popup.js';

describe('createPopupElement', () => {
  it('renders popup title and content as text instead of executable HTML', () => {
    const unsafe = '<img src=x onerror=alert(1)>';
    const popup = createPopupElement({
      title: unsafe,
      content: `Sync failed:\n${unsafe}`,
      type: 'danger',
    });

    expect(popup.querySelector('.pp-dev-info__popup-title-text')?.textContent).toBe(unsafe);
    expect(popup.querySelector('.pp-dev-info__popup-content')?.textContent).toBe(`Sync failed:\n${unsafe}`);
    expect(popup.querySelector('img')).toBeNull();
    expect(popup.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(popup.querySelector('.pp-dev-info__popup-title-icon svg')).not.toBeNull();
  });

  it('renders the close control as a focusable, labeled button', () => {
    const popup = createPopupElement({ title: 'Title', content: 'Content' });
    const $close = popup.querySelector('.pp-dev-info__popup-title-close');

    expect($close?.tagName).toBe('BUTTON');
    expect($close?.getAttribute('type')).toBe('button');
    expect($close?.getAttribute('aria-label')).toBe('Close');
  });
});

/**
 * Popups close themselves after a while. Each one added a `visibilitychange` listener to the page
 * that was never removed, and a popup closed by hand kept its timer running.
 */
describe('startAutoDismiss', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function visibilityListeners() {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');

    return () =>
      add.mock.calls.filter(([type]) => type === 'visibilitychange').length -
      remove.mock.calls.filter(([type]) => type === 'visibilitychange').length;
  }

  it('calls back once the time is up, and leaves no listener behind', () => {
    vi.useFakeTimers({ toFake: ['Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });

    const listeners = visibilityListeners();
    const onElapsed = vi.fn();

    startAutoDismiss(1_000, onElapsed);

    expect(listeners()).toBe(1);

    vi.advanceTimersByTime(900);
    expect(onElapsed).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(onElapsed).toHaveBeenCalledTimes(1);
    expect(listeners()).toBe(0);

    vi.advanceTimersByTime(5_000);
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  it('never calls back once stopped, and removes its listener', () => {
    vi.useFakeTimers({ toFake: ['Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });

    const listeners = visibilityListeners();
    const onElapsed = vi.fn();
    const stop = startAutoDismiss(1_000, onElapsed);

    stop();
    vi.advanceTimersByTime(5_000);

    expect(onElapsed).not.toHaveBeenCalled();
    expect(listeners()).toBe(0);
  });
});
