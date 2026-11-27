/**
 * Keeps the dev panel within the screen. The panel is never wider than the viewport (CSS); when its
 * items don't fit, it goes compact: icons with tooltips in place of the labels and long values. What
 * still doesn't fit scrolls sideways, with the wheel too. Decided by what overflows, not by a
 * breakpoint: the backend URL, the environment list and the buttons make the width.
 */

export const COMPACT_CLASS = 'pp-dev-info--compact';

export function initPanelFit($panel: HTMLElement, win: Window = window): () => void {
  const $content = $panel.querySelector<HTMLElement>('.pp-dev-info__content');

  if (!$content) {
    return () => {};
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  const overflows = () => $content.scrollWidth > $content.clientWidth + 1;

  /** Full first; compact only when that overflows (a wider window takes the labels back). */
  const fit = () => {
    timer = undefined;
    $panel.classList.remove(COMPACT_CLASS);

    if (overflows()) {
      $panel.classList.add(COMPACT_CLASS);
    }
  };

  // A timer, not an animation frame: a frame asked for in a hidden tab waited, and every change after
  // it was dropped as already scheduled.
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(fit, 50);
  };

  // A vertical wheel scrolls the items sideways while they overflow; otherwise the page scrolls.
  const onWheel = (event: WheelEvent) => {
    if (!overflows() || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
      return;
    }

    $content.scrollLeft += event.deltaY;
    event.preventDefault();
  };

  // Items come and go (the environment list replaces its name), and web fonts change the widths.
  const observer = new MutationObserver(schedule);

  observer.observe($content, { childList: true, subtree: true, characterData: true });
  win.addEventListener('resize', schedule);

  // The viewport's width as layout sees it (also where no `resize` comes, e.g. an emulated device),
  // and the items' own box.
  const Observer = (win as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  const resizes = typeof Observer === 'function' ? new Observer(schedule) : undefined;

  resizes?.observe(win.document.documentElement);
  resizes?.observe($content);
  $content.addEventListener('wheel', onWheel, { passive: false });
  void win.document.fonts?.ready.then(schedule);

  fit();

  return () => {
    observer.disconnect();
    resizes?.disconnect();
    win.removeEventListener('resize', schedule);
    $content.removeEventListener('wheel', onWheel);

    clearTimeout(timer);
  };
}
