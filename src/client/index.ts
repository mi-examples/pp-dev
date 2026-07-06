/// <reference types="vite/client" />
import './assets/css/client.scss';
import './index.html';
import { createPPDevHotContext } from './hot-context.js';
import { STORAGE_KEYS, getStorageItem, setStorageItem } from './storage.js';
import { createPanelStateController, type PanelStateController } from './panel-state.js';
import { initDrag, initAutoHide } from './panel-position.js';
import { initPanelSettings } from './panel-settings.js';

interface InfoPopupOptions {
  title: string;
  content: string;
  style?: string;
  className?: string;
  duration?: number;
  onClose?: () => void;
  type?: 'success' | 'danger' | 'info' | 'warning';
}

interface SyncActionRequiredPayload {
  requestId: string;
  title: string;
  content: string;
  confirmText: string;
  cancelText: string;
}

interface ConfirmModalOptions {
  title: string;
  content: string;
  confirmText: string;
  cancelText: string;
}

let activePopups = 0;
const POPUP_OFFSET = 10;
const POPUP_HEIGHT = 100;
const ANIMATION_DURATION = 300;
const CONFIRM_MODAL_OVERLAY_CLASS = 'pp-dev-info__confirm-overlay';

const activeConfirmModals = new Map<
  HTMLDivElement,
  { resolve: (value: boolean) => void; onKeyDown: (event: KeyboardEvent) => void }
>();

const ICON_SIZE = 16;
const CLOSE_ICON_SIZE = 12;

function teardownConfirmModal(overlay: HTMLDivElement, result: boolean) {
  const entry = activeConfirmModals.get(overlay);

  if (!entry) {
    return;
  }

  document.removeEventListener('keydown', entry.onKeyDown);

  activeConfirmModals.delete(overlay);
  overlay.remove();
  entry.resolve(result);
}

const TYPE_ICONS: Record<NonNullable<InfoPopupOptions['type']>, string> = {
  success: `<svg viewBox="0 0 24 24" width="${ICON_SIZE}" height="${ICON_SIZE}" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`,
  danger: `<svg viewBox="0 0 24 24" width="${ICON_SIZE}" height="${ICON_SIZE}" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`,
  warning: `<svg viewBox="0 0 24 24" width="${ICON_SIZE}" height="${ICON_SIZE}" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
  info: `<svg viewBox="0 0 24 24" width="${ICON_SIZE}" height="${ICON_SIZE}" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`,
};

function createPopupElement(opts: InfoPopupOptions): HTMLDivElement {
  const $popup = document.createElement('div');

  $popup.classList.add('pp-dev-info-namespace');

  const typeClass = opts.type ? `pp-dev-info__popup--${opts.type}` : '';
  const iconHtml = opts.type ? `<div class="pp-dev-info__popup-title-icon">${TYPE_ICONS[opts.type]}</div>` : '';

  const template = `
    <div class="pp-dev-info__popup ${typeClass} ${opts.className || ''}" style="${opts.style || ''}">
      <div class="pp-dev-info__popup-title">
        ${iconHtml}
        <div class="pp-dev-info__popup-title-text">${opts.title}</div>
        <div class="pp-dev-info__popup-title-close">
          <svg
            viewBox="0 0 24 24"
            width="${CLOSE_ICON_SIZE}"
            height="${CLOSE_ICON_SIZE}"
            stroke="currentColor"
            stroke-width="1.5"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M18 6L6 18"></path>
            <path d="M6 6l12 12"></path>
          </svg>
        </div>
      </div>
      <div class="pp-dev-info__popup-content">${opts.content}</div>
    </div>
  `;

  $popup.innerHTML = template;

  return $popup;
}

let panelController: PanelStateController | null = null;

function updatePopupPositions() {
  const popups = document.querySelectorAll<HTMLElement>('.pp-dev-info-namespace:not(.pp-dev-info)');
  const position = panelController?.getState().position ?? 'bottom-right';
  const isLeft = position === 'top-left' || position === 'bottom-left';
  const isTop = position === 'top-left' || position === 'top-right';

  // Anchor popups to the panel's horizontal side and stack them from the vertically
  // opposite edge so they never cover the panel.
  popups.forEach((popup, index: number) => {
    const offset = POPUP_OFFSET + index * (POPUP_HEIGHT + POPUP_OFFSET);
    const $popupContent = popup.querySelector<HTMLElement>('.pp-dev-info__popup');

    if (!$popupContent) {
      return;
    }

    $popupContent.classList.toggle('pp-dev-info__popup--left', isLeft);

    if (isTop) {
      $popupContent.style.top = 'auto';
      $popupContent.style.bottom = `${offset}px`;
    } else {
      $popupContent.style.bottom = 'auto';
      $popupContent.style.top = `${offset}px`;
    }
  });
}

function animatePopup($popup: HTMLDivElement, type: 'enter' | 'exit') {
  return new Promise<void>((resolve) => {
    const $popupContent = $popup.querySelector('.pp-dev-info__popup');

    if (!$popupContent) {
      return resolve();
    }

    if (type === 'enter') {
      $popupContent.classList.add('entering');

      requestAnimationFrame(() => {
        $popupContent.classList.remove('entering');

        resolve();
      });
    } else {
      $popupContent.classList.add('exiting');

      setTimeout(() => {
        $popupContent.classList.remove('exiting');

        resolve();
      }, ANIMATION_DURATION);
    }
  });
}

function infoPopup(opts: InfoPopupOptions) {
  const $popup = createPopupElement(opts);
  const $closeButton = $popup.querySelector('.pp-dev-info__popup-title-close');

  const removePopup = async () => {
    await animatePopup($popup, 'exit');

    $popup.remove();

    activePopups--;

    updatePopupPositions();

    opts.onClose?.();
  };

  $closeButton?.addEventListener('click', removePopup);
  document.body.appendChild($popup);

  // Position the popup
  activePopups++;
  updatePopupPositions();

  // Animate entrance
  animatePopup($popup, 'enter');

  const duration = opts.duration ?? 10000;

  if (duration > 0) {
    let remainingTime = duration;
    let lastUpdate = Date.now();
    let isVisible = true;

    const scheduleDismiss = () => {
      if (!isVisible) {
        return;
      }

      const now = Date.now();
      const elapsed = now - lastUpdate;

      remainingTime -= elapsed;
      lastUpdate = now;

      if (remainingTime <= 0) {
        removePopup();

        return;
      }

      requestAnimationFrame(scheduleDismiss);
    };

    // Handle visibility change
    document.addEventListener('visibilitychange', () => {
      isVisible = !document.hidden;

      if (isVisible) {
        lastUpdate = Date.now();
        requestAnimationFrame(scheduleDismiss);
      }
    });

    requestAnimationFrame(scheduleDismiss);
  }
}

function closeAllConfirmModals() {
  for (const overlay of [...activeConfirmModals.keys()]) {
    teardownConfirmModal(overlay, false);
  }
}

function confirmModal(opts: ConfirmModalOptions): Promise<boolean> {
  closeAllConfirmModals();

  return new Promise<boolean>((resolve) => {
    const $overlay = document.createElement('div');

    $overlay.classList.add('pp-dev-info-namespace', CONFIRM_MODAL_OVERLAY_CLASS);

    const $confirm = document.createElement('div');

    $confirm.classList.add('pp-dev-info__confirm');

    const $title = document.createElement('div');

    $title.classList.add('pp-dev-info__confirm-title');
    $title.textContent = opts.title;

    const $content = document.createElement('div');

    $content.classList.add('pp-dev-info__confirm-content');
    $content.textContent = opts.content;

    const $actions = document.createElement('div');

    $actions.classList.add('pp-dev-info__confirm-actions');

    const $cancelButton = document.createElement('button');

    $cancelButton.type = 'button';
    $cancelButton.classList.add('pp-dev-info__confirm-btn', 'pp-dev-info__confirm-btn--cancel');
    $cancelButton.textContent = opts.cancelText;

    const $confirmButton = document.createElement('button');

    $confirmButton.type = 'button';
    $confirmButton.classList.add('pp-dev-info__confirm-btn', 'pp-dev-info__confirm-btn--confirm');
    $confirmButton.textContent = opts.confirmText;

    $actions.append($cancelButton, $confirmButton);
    $confirm.append($title, $content, $actions);
    $overlay.appendChild($confirm);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        teardownConfirmModal($overlay, false);
      }
    };

    activeConfirmModals.set($overlay, { resolve, onKeyDown });

    $confirmButton.addEventListener('click', () => {
      teardownConfirmModal($overlay, true);
    });

    $cancelButton.addEventListener('click', () => {
      teardownConfirmModal($overlay, false);
    });

    $overlay.addEventListener('click', (event) => {
      if (event.target === $overlay) {
        teardownConfirmModal($overlay, false);
      }
    });

    document.addEventListener('keydown', onKeyDown);
    document.body.appendChild($overlay);
  });
}

// ── Inspector console banner ──────────────────────────────────────────────────
// Logged once on page load so it is visible in DevTools history when the console
// is opened. The message is harmless if the inspector is disabled.
(function printInspectorBanner() {
  const url = window.location.origin + '/@pp-dev/inspector';

  console.log(
    '%cpp-dev%c  🔍 Request Inspector  →  %c%s',
    'background:#6e8efb;color:#fff;padding:2px 8px;border-radius:4px;font-weight:700;font-size:11px',
    'color:#a0a0b8;font-size:11px',
    'color:#a78bfa;font-size:11px;text-decoration:underline',
    url,
  );
})();

// ── Panel UI: position, auto-hide, hide, minimize ─────────────────────────────
// Initialized outside the hot-context guard — panel placement and visibility must
// not depend on the WebSocket transport being available.
const CLOSED_CLASS = 'closed';

const $infoPanel = document.querySelector<HTMLElement>('.pp-dev-info');

if ($infoPanel) {
  panelController = createPanelStateController($infoPanel);

  const $dragHandle = $infoPanel.querySelector<HTMLElement>('.pp-dev-info__drag-handle');

  if ($dragHandle) {
    initDrag($infoPanel, $dragHandle, (corner) => panelController!.setPosition(corner));
  }

  const autoHide = initAutoHide($infoPanel, () => panelController!.getState().autoHide);

  initPanelSettings($infoPanel, panelController, {
    onOpenChange: (open) => autoHide.keepPeeked(open),
  });

  panelController.onChange((state) => {
    if (!state.autoHide) {
      $infoPanel.classList.remove('is-peeking');
    }

    updatePopupPositions();
  });

  // Minimize button; in auto-hide mode it acts as "pin" (disables auto-hide).
  const $minimizeButtonWrap = $infoPanel.querySelector<HTMLElement>('.pp-dev-info__wrap-btn');
  const $minimizeButtonSVG = $minimizeButtonWrap?.querySelector('svg');

  if ($minimizeButtonWrap && $minimizeButtonSVG) {
    let isClosed = getStorageItem(STORAGE_KEYS.closed) === 'true' && !panelController.getState().autoHide;

    const updateTitle = () => {
      $minimizeButtonWrap.title = panelController!.getState().autoHide ? 'Pin panel' : 'Minimize';
    };

    updateTitle();
    panelController.onChange(updateTitle);

    if (isClosed) {
      $infoPanel.classList.add(CLOSED_CLASS);
      $minimizeButtonSVG.classList.add(CLOSED_CLASS);
    }

    $minimizeButtonWrap.addEventListener('click', (e: Event) => {
      e.preventDefault();

      if (panelController!.getState().autoHide) {
        isClosed = false;
        panelController!.setAutoHide(false);

        return;
      }

      $infoPanel.classList.toggle(CLOSED_CLASS);
      $minimizeButtonSVG.classList.toggle(CLOSED_CLASS);

      isClosed = !isClosed;

      setStorageItem(STORAGE_KEYS.closed, isClosed ? 'true' : 'false');
    });
  }
}

// Use Vite's HMR context when available; otherwise fall back to a raw-WebSocket
// shim so the dev panel also works under the `pp-dev next` server (no Vite HMR).
const hot = import.meta.hot ?? createPPDevHotContext();

if (hot) {
  hot.on('redirect', (data: { url: string }) => {
    window.location.href = data.url;
  });

  hot.on('client:config:update', (data: { config: { [key: string]: any } }) => {
    if (typeof data.config?.canSync === 'boolean') {
      if (data.config.canSync) {
        const $syncButton = document.getElementById('sync-template') as HTMLButtonElement | null;

        if ($syncButton) {
          $syncButton.disabled = false;
          $syncButton.classList.remove('disabled');
          $syncButton.title = 'Sync template';
        }
      } else {
        const $syncButton = document.getElementById('sync-template') as HTMLButtonElement | null;

        if ($syncButton) {
          $syncButton.disabled = true;
          $syncButton.classList.add('disabled');
          $syncButton.title = 'Sync is unavailable on this instance';
        }
      }
    }
  });

  const $syncButton = document.getElementById('sync-template') as HTMLButtonElement | null;

  if ($syncButton) {
    hot.on('template:sync:action-required', async (payload: SyncActionRequiredPayload) => {
      // Keep the sync spinner running while a confirmation modal is shown — the sync
      // process is still in progress and only ends on `template:sync:response`.
      const approved = await confirmModal({
        title: payload.title,
        content: payload.content,
        confirmText: payload.confirmText,
        cancelText: payload.cancelText,
      });

      hot.send('template:sync:action-response', {
        requestId: payload.requestId,
        approved,
      });
    });

    hot.on(
      'template:sync:response',
      (
        payload:
          | { syncedAt: string; currentHash: string; backupFilename: string }
          | { error: string; config?: { [p: string]: any }; refresh?: boolean }
          | { cancelled: boolean; message: string },
      ) => {
        closeAllConfirmModals();
        $syncButton.classList.remove('syncing');

        if ('cancelled' in payload && payload.cancelled) {
          infoPopup({
            title: 'Sync cancelled',
            content: payload.message,
            type: 'warning',
          });
        } else if ('error' in payload && typeof payload.error !== 'undefined') {
          infoPopup({
            title: 'Sync error',
            content: payload.error,
            type: 'danger',
          });

          if (payload.refresh) {
            setTimeout(() => {
              window.location.reload();
            });
          } else {
            $syncButton.disabled = true;
            $syncButton.classList.add('disabled');
            $syncButton.title = 'Sync is unavailable on this instance';
          }
        } else if ('syncedAt' in payload && typeof payload.syncedAt !== 'undefined') {
          infoPopup({
            title: 'Sync success',
            content: `Synced at ${new Date(payload.syncedAt).toLocaleString()}.<br />Backup filename: ${
              payload.backupFilename
            }`,
            type: 'success',
          });
        }
      },
    );

    $syncButton.addEventListener('click', (ev: Event) => {
      ev.preventDefault();

      $syncButton.classList.add('syncing');

      hot.send('template:sync', {});
    });
  }
}
