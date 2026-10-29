import type { ViteHotContext } from 'vite/types/hot.js';
import type { InfoPopupOptions } from './popup.js';
import {
  SYNC_IN_PROGRESS_CODE,
  type SyncActionRequiredPayload,
  type SyncActionResponsePayload,
  type TemplateSyncResponsePayload,
} from '../shared/ws-messages.js';

export type { SyncActionRequiredPayload, TemplateSyncResponsePayload };

const TITLE_AVAILABLE = 'Sync template';
const TITLE_UNAVAILABLE = 'Sync is unavailable on this instance';

export interface ConfirmModalOptions {
  title: string;
  content: string;
  confirmText: string;
  cancelText: string;
}

export interface SyncButtonDeps {
  infoPopup: (opts: InfoPopupOptions) => unknown;
  confirmModal: (opts: ConfirmModalOptions) => Promise<boolean>;
  closeAllConfirmModals: () => void;
  /** Reloads the page (an expired session); `window.location.reload` by default. */
  reload?: () => void;
}

/**
 * Wires the dev panel's "Sync template" button to the dev server.
 *
 * The button is disabled while a sync runs, so a double click can't start a second build, and is
 * enabled again by whatever ends the sync: its response, or a lost connection. It stays disabled
 * only when the server says sync is unavailable on this instance (`config.canSync === false`);
 * a failed sync (MI unreachable, a build error) can simply be retried.
 */
export function initSyncButton(
  hot: Pick<ViteHotContext, 'on' | 'send'> & { isConnected?: () => boolean },
  $button: HTMLButtonElement,
  deps: SyncButtonDeps,
): void {
  const reload = deps.reload ?? (() => window.location.reload());

  let available = !$button.disabled && !$button.classList.contains('disabled');
  let syncing = false;
  // Vite's connection is taken as open until reported lost: it may have opened before these handlers
  // were registered, and its client reloads the page once a lost one is back. The `pp-dev next`
  // transport says itself whether its socket is open, also while the first one is still connecting.
  let connected = true;
  const isConnected = () => connected && (hot.isConnected?.() ?? true);

  const applyState = () => {
    $button.disabled = syncing || !available;
    $button.classList.toggle('syncing', syncing);
    $button.classList.toggle('disabled', !available);
    $button.title = available ? TITLE_AVAILABLE : TITLE_UNAVAILABLE;

    if (syncing) {
      $button.setAttribute('aria-busy', 'true');
    } else {
      $button.removeAttribute('aria-busy');
    }
  };

  const endSync = () => {
    syncing = false;
    applyState();
  };

  hot.on('client:config:update', (data: { config?: { canSync?: unknown } }) => {
    if (typeof data?.config?.canSync !== 'boolean') {
      return;
    }

    // The server sends `canSync: true` at the start of every sync: it must not enable the
    // button while that sync runs, which `applyState` takes care of.
    available = data.config.canSync;
    applyState();
  });

  hot.on('template:sync:action-required', async (payload: SyncActionRequiredPayload) => {
    // The spinner keeps running while a confirmation modal is shown: the sync is still in
    // progress and only ends on `template:sync:response`.
    const approved = await deps.confirmModal({
      title: payload.title,
      content: payload.content,
      confirmText: payload.confirmText,
      cancelText: payload.cancelText,
    });

    hot.send('template:sync:action-response', {
      requestId: payload.requestId,
      approved,
    } satisfies SyncActionResponsePayload);
  });

  hot.on('template:sync:response', (payload: TemplateSyncResponsePayload) => {
    deps.closeAllConfirmModals();

    if ('error' in payload && payload.config?.canSync === false) {
      available = false;
    }

    endSync();

    if ('cancelled' in payload && payload.cancelled) {
      deps.infoPopup({ title: 'Sync cancelled', content: payload.message, type: 'warning' });

      return;
    }

    if ('error' in payload && typeof payload.error !== 'undefined') {
      if (payload.code === SYNC_IN_PROGRESS_CODE) {
        deps.infoPopup({ title: 'Sync already running', content: payload.error, type: 'warning' });

        return;
      }

      deps.infoPopup({ title: 'Sync error', content: payload.error, type: 'danger' });

      if (payload.refresh) {
        setTimeout(reload);
      }

      return;
    }

    if ('syncedAt' in payload && typeof payload.syncedAt !== 'undefined') {
      deps.infoPopup({
        title: 'Sync success',
        content: `Synced at ${new Date(payload.syncedAt).toLocaleString()}.\nBackup filename: ${payload.backupFilename}`,
        type: 'success',
      });
    }
  });

  // A response sent to a socket that has closed never arrives. Without this, the button would
  // spin, disabled, until the page is reloaded.
  hot.on('vite:ws:connect', () => {
    connected = true;
  });

  hot.on('vite:ws:disconnect', () => {
    connected = false;

    if (!syncing) {
      return;
    }

    deps.closeAllConfirmModals();
    endSync();
    deps.infoPopup({
      title: 'Sync result unknown',
      content:
        'The connection to the dev server was lost during the sync. Check its terminal for the result before syncing again.',
      type: 'warning',
    });
  });

  $button.addEventListener('click', (ev: Event) => {
    ev.preventDefault();

    if (syncing || !available) {
      return;
    }

    // Sent now, the request would wait for a reconnect with the button spinning, and start a sync
    // whenever that happens. Say so instead, and let the click be repeated once connected.
    if (!isConnected()) {
      deps.infoPopup({
        title: 'No connection',
        content: 'The dev server is not connected. Check that it is running, then try again.',
        type: 'warning',
      });

      return;
    }

    syncing = true;
    applyState();
    hot.send('template:sync', {});
  });
}
