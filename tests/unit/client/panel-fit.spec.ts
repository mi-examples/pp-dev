// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { COMPACT_CLASS, initPanelFit } from '../../../src/client/panel-fit.js';

/**
 * The dev panel within the screen: icons in place of the labels when its items don't fit, then a
 * sideways scroll. jsdom has no layout, so the items' widths are given: `full` when the labels show,
 * `compact` with icons, and the room the screen leaves.
 */

function setup(widths: { full: number; compact: number; room: number }) {
  document.body.innerHTML = `
    <div class="pp-dev-info"><div class="pp-dev-info__content"><span class="pp-dev-info__item"></span></div></div>`;

  const $panel = document.querySelector<HTMLElement>('.pp-dev-info')!;
  const $content = $panel.querySelector<HTMLElement>('.pp-dev-info__content')!;
  const size = { ...widths };

  Object.defineProperty($content, 'scrollWidth', {
    get: () => ($panel.classList.contains(COMPACT_CLASS) ? size.compact : size.full),
  });
  Object.defineProperty($content, 'clientWidth', {
    get: () => Math.min(size.room, $panel.classList.contains(COMPACT_CLASS) ? size.compact : size.full),
  });

  const stop = initPanelFit($panel);

  return { $panel, $content, size, stop };
}

describe('initPanelFit', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the labels where the items fit', () => {
    const { $panel, stop } = setup({ full: 780, compact: 280, room: 1000 });

    expect($panel.classList.contains(COMPACT_CLASS)).toBe(false);
    stop();
  });

  it('goes compact where they do not', () => {
    const { $panel, stop } = setup({ full: 780, compact: 280, room: 700 });

    expect($panel.classList.contains(COMPACT_CLASS)).toBe(true);
    stop();
  });

  it('follows the screen: compact when it narrows, the labels back when it widens', () => {
    vi.useFakeTimers();

    const { $panel, size, stop } = setup({ full: 780, compact: 280, room: 1000 });

    size.room = 600;
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(100);
    expect($panel.classList.contains(COMPACT_CLASS)).toBe(true);

    size.room = 1400;
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(100);
    expect($panel.classList.contains(COMPACT_CLASS)).toBe(false);
    stop();
  });

  it('fits again when the items change (the environment list in place of its name)', async () => {
    vi.useFakeTimers();

    const { $panel, $content, size, stop } = setup({ full: 780, compact: 280, room: 800 });

    expect($panel.classList.contains(COMPACT_CLASS)).toBe(false);

    size.full = 900;
    $content.append(document.createElement('select'));
    await Promise.resolve();
    vi.advanceTimersByTime(100);

    expect($panel.classList.contains(COMPACT_CLASS)).toBe(true);
    stop();
  });

  it('scrolls the items sideways with the wheel while even the icons overflow', () => {
    const { $content, stop } = setup({ full: 780, compact: 280, room: 200 });
    const wheel = new WheelEvent('wheel', { deltaY: 40, cancelable: true });

    $content.dispatchEvent(wheel);

    expect($content.scrollLeft).toBe(40);
    expect(wheel.defaultPrevented).toBe(true);
    stop();
  });

  it('leaves the wheel to the page when nothing overflows', () => {
    const { $content, stop } = setup({ full: 780, compact: 280, room: 1000 });
    const wheel = new WheelEvent('wheel', { deltaY: 40, cancelable: true });

    $content.dispatchEvent(wheel);

    expect($content.scrollLeft).toBe(0);
    expect(wheel.defaultPrevented).toBe(false);
    stop();
  });
});
