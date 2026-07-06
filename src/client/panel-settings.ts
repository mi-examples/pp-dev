import type { Corner, PanelStateController } from './panel-state.js';
import { CORNERS } from './panel-state.js';

const CORNER_TITLES: Record<Corner, string> = {
  'top-left': 'Top left',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-right': 'Bottom right',
};

function buildPopover(controller: PanelStateController): HTMLDivElement {
  const state = controller.getState();
  const $popover = document.createElement('div');

  $popover.classList.add('pp-dev-info__settings');

  const cornerButtons = CORNERS.map((corner) => {
    const active = corner === state.position ? ' active' : '';

    return `<button type="button" class="pp-dev-info__corner-btn pp-dev-info__corner-btn--${corner}${active}" data-corner="${corner}" title="${CORNER_TITLES[corner]}" aria-pressed="${corner === state.position}"></button>`;
  }).join('');

  $popover.innerHTML = `
    <div class="pp-dev-info__settings-title">Panel settings</div>
    <div class="pp-dev-info__settings-row">
      <span class="pp-dev-info__settings-label">Position</span>
      <div class="pp-dev-info__corner-grid">${cornerButtons}</div>
    </div>
    <div class="pp-dev-info__settings-row">
      <label class="pp-dev-info__settings-label" for="pp-dev-auto-hide-toggle">Auto-hide</label>
      <input
        type="checkbox"
        id="pp-dev-auto-hide-toggle"
        class="pp-dev-info__settings-toggle"
        ${state.autoHide ? 'checked' : ''}
      />
    </div>
    <button type="button" class="pp-dev-info__settings-hide-btn">Hide panel</button>
    <div class="pp-dev-info__settings-hint">Restore with <code>?pp-dev-panel=show</code> in the URL</div>
    <span class="pp-dev-info__settings-reset" role="button" tabindex="0">Reset to config defaults</span>
  `;

  return $popover;
}

function syncPopover($popover: HTMLDivElement, controller: PanelStateController): void {
  const state = controller.getState();

  $popover.querySelectorAll<HTMLButtonElement>('.pp-dev-info__corner-btn').forEach(($btn) => {
    const active = $btn.dataset.corner === state.position;

    $btn.classList.toggle('active', active);
    $btn.setAttribute('aria-pressed', String(active));
  });

  const $toggle = $popover.querySelector<HTMLInputElement>('.pp-dev-info__settings-toggle');

  if ($toggle) {
    $toggle.checked = state.autoHide;
  }
}

export interface PanelSettingsHooks {
  onOpenChange?: (open: boolean) => void;
}

/** Settings popover: corner picker, auto-hide toggle, hide button, reset. */
export function initPanelSettings(
  $panel: HTMLElement,
  controller: PanelStateController,
  hooks?: PanelSettingsHooks,
): void {
  const $btn = $panel.querySelector<HTMLButtonElement>('.pp-dev-info__settings-btn');

  if (!$btn) {
    return;
  }

  let $popover: HTMLDivElement | null = null;

  const onDocClick = (ev: MouseEvent) => {
    const target = ev.target as Node;

    if ($popover && !$popover.contains(target) && !$btn.contains(target)) {
      close();
    }
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      close();
    }
  };

  const close = () => {
    if (!$popover) {
      return;
    }

    $popover.remove();
    $popover = null;
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    hooks?.onOpenChange?.(false);
  };

  const open = () => {
    $popover = buildPopover(controller);

    $popover.querySelectorAll<HTMLButtonElement>('.pp-dev-info__corner-btn').forEach(($cornerBtn) => {
      $cornerBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        controller.setPosition($cornerBtn.dataset.corner as Corner);
      });
    });

    $popover.querySelector<HTMLInputElement>('.pp-dev-info__settings-toggle')?.addEventListener('change', (ev) => {
      controller.setAutoHide((ev.target as HTMLInputElement).checked);
    });

    $popover.querySelector<HTMLButtonElement>('.pp-dev-info__settings-hide-btn')?.addEventListener('click', (ev) => {
      ev.preventDefault();
      close();
      controller.setHidden(true);
    });

    const $reset = $popover.querySelector<HTMLElement>('.pp-dev-info__settings-reset');

    $reset?.addEventListener('click', (ev) => {
      ev.preventDefault();
      controller.reset();
    });
    $reset?.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        controller.reset();
      }
    });

    $panel.appendChild($popover);
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    hooks?.onOpenChange?.(true);
  };

  $btn.addEventListener('click', (ev) => {
    ev.preventDefault();

    if ($popover) {
      close();
    } else {
      open();
    }
  });

  controller.onChange(() => {
    if ($popover) {
      syncPopover($popover, controller);
    }
  });
}
