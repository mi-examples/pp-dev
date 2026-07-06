import type { Corner } from './panel-state.js';

export const AUTO_HIDE_SHOW_DELAY = 300;
export const AUTO_HIDE_HIDE_DELAY = 500;

const PEEKING_CLASS = 'is-peeking';
const DRAGGING_CLASS = 'is-dragging';

/** Nearest screen corner for a viewport point; ties resolve toward bottom-right. */
export function nearestCorner(x: number, y: number, viewportWidth: number, viewportHeight: number): Corner {
  const left = x < viewportWidth / 2;
  const top = y < viewportHeight / 2;

  if (top) {
    return left ? 'top-left' : 'top-right';
  }

  return left ? 'bottom-left' : 'bottom-right';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Drag the panel by its handle and snap to the nearest corner on release.
 * Pointer capture keeps the drag tracking over iframes and outside the window.
 */
export function initDrag($panel: HTMLElement, $handle: HTMLElement, onSnap: (corner: Corner) => void): void {
  let dragging = false;
  let pointerId = -1;
  let offsetX = 0;
  let offsetY = 0;
  let panelWidth = 0;
  let panelHeight = 0;

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      stop(false);
    }
  };

  const stop = (snap: boolean, ev?: PointerEvent) => {
    if (!dragging) {
      return;
    }

    dragging = false;

    try {
      $handle.releasePointerCapture(pointerId);
    } catch {
      // pointer already released
    }

    document.body.style.userSelect = '';
    document.removeEventListener('keydown', onKeyDown, true);

    // Re-enable transitions before clearing the inline placement so the snap animates.
    $panel.classList.remove(DRAGGING_CLASS);
    $panel.style.left = '';
    $panel.style.top = '';
    $panel.style.right = '';
    $panel.style.bottom = '';
    $panel.style.transform = '';

    if (snap && ev) {
      onSnap(nearestCorner(ev.clientX, ev.clientY, window.innerWidth, window.innerHeight));
    }
  };

  const moveTo = (ev: PointerEvent) => {
    const x = clamp(ev.clientX - offsetX, 0, Math.max(0, window.innerWidth - panelWidth));
    const y = clamp(ev.clientY - offsetY, 0, Math.max(0, window.innerHeight - panelHeight));

    $panel.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };

  $handle.addEventListener('pointerdown', (ev: PointerEvent) => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) {
      return;
    }

    const rect = $panel.getBoundingClientRect();

    dragging = true;
    pointerId = ev.pointerId;
    offsetX = ev.clientX - rect.left;
    offsetY = ev.clientY - rect.top;
    panelWidth = rect.width;
    panelHeight = rect.height;

    $handle.setPointerCapture(ev.pointerId);
    $panel.classList.add(DRAGGING_CLASS);

    // Anchor to the top-left origin so translate3d coordinates are viewport-absolute;
    // inline styles override the corner-class placement for the duration of the drag.
    $panel.style.left = '0';
    $panel.style.top = '0';
    $panel.style.right = 'auto';
    $panel.style.bottom = 'auto';

    moveTo(ev);

    document.body.style.userSelect = 'none';
    document.addEventListener('keydown', onKeyDown, true);
    ev.preventDefault();
  });

  $handle.addEventListener('pointermove', (ev: PointerEvent) => {
    if (dragging) {
      moveTo(ev);
    }
  });

  $handle.addEventListener('pointerup', (ev: PointerEvent) => stop(true, ev));
  $handle.addEventListener('pointercancel', () => stop(false));
}

export interface AutoHideHandle {
  /** Force the panel to stay revealed (e.g. while the settings popover is open). */
  keepPeeked(on: boolean): void;
}

/**
 * Hover-reveal behavior for the auto-hide mode: pointer over the exposed strip for
 * AUTO_HIDE_SHOW_DELAY slides the panel out; leaving re-hides it after a grace period.
 * Keyboard focus inside the panel also keeps it revealed.
 */
export function initAutoHide($panel: HTMLElement, isActive: () => boolean): AutoHideHandle {
  let showTimer: number | undefined;
  let hideTimer: number | undefined;
  let popoverOpen = false;

  const shouldStayPeeked = () =>
    popoverOpen || $panel.matches(':focus-within') || $panel.classList.contains(DRAGGING_CLASS);

  const scheduleHide = () => {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (!shouldStayPeeked() && !$panel.matches(':hover')) {
        $panel.classList.remove(PEEKING_CLASS);
      }
    }, AUTO_HIDE_HIDE_DELAY);
  };

  $panel.addEventListener('pointerenter', () => {
    if (!isActive()) {
      return;
    }

    window.clearTimeout(hideTimer);
    showTimer = window.setTimeout(() => $panel.classList.add(PEEKING_CLASS), AUTO_HIDE_SHOW_DELAY);
  });

  $panel.addEventListener('pointerleave', () => {
    if (!isActive()) {
      return;
    }

    window.clearTimeout(showTimer);
    scheduleHide();
  });

  $panel.addEventListener('focusin', () => {
    if (isActive()) {
      window.clearTimeout(hideTimer);
      $panel.classList.add(PEEKING_CLASS);
    }
  });

  $panel.addEventListener('focusout', () => {
    if (isActive()) {
      scheduleHide();
    }
  });

  return {
    keepPeeked(on: boolean) {
      popoverOpen = on;

      if (!isActive()) {
        return;
      }

      if (on) {
        window.clearTimeout(showTimer);
        window.clearTimeout(hideTimer);
        $panel.classList.add(PEEKING_CLASS);
      } else {
        scheduleHide();
      }
    },
  };
}
