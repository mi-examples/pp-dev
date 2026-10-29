// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initSyncButton, type SyncButtonDeps } from '../../../src/client/sync-button.js';

/**
 * The dev panel's "Sync template" button.
 *
 * Regressions covered: a double click (or a click on a spinning button) sent a second
 * `template:sync`, and any failed sync disabled the button as "unavailable on this instance"
 * until the page was reloaded, although most failures (MI unreachable, a build error) are
 * transient.
 */

type Handler = (payload: any) => unknown;

function makeHot() {
  const handlers = new Map<string, Handler[]>();
  const send = vi.fn();

  return {
    hot: {
      on(event: string, cb: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), cb]);
      },
      send,
    },
    send,
    emit(event: string, payload: unknown = {}) {
      return Promise.all((handlers.get(event) ?? []).map((cb) => cb(payload)));
    },
  };
}

function setup({ disabled = false }: { disabled?: boolean } = {}) {
  document.body.innerHTML = `<button id="sync-template" class="sync-button${disabled ? ' disabled' : ''}" title="Sync template"></button>`;

  const $button = document.getElementById('sync-template') as HTMLButtonElement;

  $button.disabled = disabled;

  const { hot, send, emit } = makeHot();
  const deps = {
    infoPopup: vi.fn(),
    confirmModal: vi.fn().mockResolvedValue(true),
    closeAllConfirmModals: vi.fn(),
    reload: vi.fn(),
  } satisfies SyncButtonDeps;

  initSyncButton(hot as never, $button, deps);

  const syncRequests = () => send.mock.calls.filter(([event]) => event === 'template:sync').length;

  return { $button, send, emit, deps, syncRequests };
}

describe('initSyncButton', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('disables the button while a sync runs, so a second click sends nothing', () => {
    const { $button, syncRequests } = setup();

    $button.click();
    $button.click();

    expect(syncRequests()).toBe(1);
    expect($button.disabled).toBe(true);
    expect($button.classList.contains('syncing')).toBe(true);
    expect($button.getAttribute('aria-busy')).toBe('true');
  });

  it('keeps the button disabled when the server announces canSync at the start of the sync', async () => {
    const { $button, emit } = setup();

    $button.click();
    await emit('client:config:update', { config: { canSync: true } });

    expect($button.disabled).toBe(true);
    expect($button.classList.contains('syncing')).toBe(true);
  });

  it('enables the button again after a failed sync, so it can be retried', async () => {
    const { $button, emit, deps, syncRequests } = setup();

    $button.click();
    await emit('template:sync:response', {
      error: 'Server in maintenance mode, VPN connection is needed or no internet connection',
      code: 'CONNECTION_ERROR',
    });

    expect($button.disabled).toBe(false);
    expect($button.classList.contains('syncing')).toBe(false);
    expect($button.classList.contains('disabled')).toBe(false);
    expect($button.title).toBe('Sync template');
    expect(deps.infoPopup).toHaveBeenCalledWith(expect.objectContaining({ title: 'Sync error', type: 'danger' }));

    $button.click();

    expect(syncRequests()).toBe(2);
  });

  it('disables the button for good only when the server says sync is unavailable', async () => {
    const { $button, emit, syncRequests } = setup();

    $button.click();
    await emit('template:sync:response', {
      error: 'This feature is available only for MI v7.1.0 or higher',
      config: { canSync: false },
    });

    expect($button.disabled).toBe(true);
    expect($button.classList.contains('disabled')).toBe(true);
    expect($button.title).toBe('Sync is unavailable on this instance');

    $button.click();

    expect(syncRequests()).toBe(1);
  });

  it('shows a sync already running elsewhere as a warning and enables the button', async () => {
    const { $button, emit, deps } = setup();

    $button.click();
    await emit('template:sync:response', { error: 'A template sync is already running.', code: 'SYNC_IN_PROGRESS' });

    expect($button.disabled).toBe(false);
    expect(deps.infoPopup).toHaveBeenCalledWith({
      title: 'Sync already running',
      content: 'A template sync is already running.',
      type: 'warning',
    });
  });

  it('enables the button and reports success after a sync', async () => {
    const { $button, emit, deps } = setup();

    $button.click();
    await emit('template:sync:response', {
      syncedAt: '2026-10-27T10:00:00.000Z',
      currentHash: 'hash',
      backupFilename: 'backup.zip',
    });

    expect($button.disabled).toBe(false);
    expect($button.classList.contains('syncing')).toBe(false);
    expect(deps.infoPopup).toHaveBeenCalledWith(expect.objectContaining({ title: 'Sync success', type: 'success' }));
  });

  it('reports a cancelled sync and closes its dialogs', async () => {
    const { $button, emit, deps } = setup();

    $button.click();
    await emit('template:sync:response', { cancelled: true, message: 'Sync cancelled by user. Backup was saved.' });

    expect($button.disabled).toBe(false);
    expect(deps.closeAllConfirmModals).toHaveBeenCalled();
    expect(deps.infoPopup).toHaveBeenCalledWith(expect.objectContaining({ title: 'Sync cancelled', type: 'warning' }));
  });

  it('reloads the page when the session expired', async () => {
    vi.useFakeTimers();

    try {
      const { $button, emit, deps } = setup();

      $button.click();
      await emit('template:sync:response', { error: 'Session expired', code: 'SESSION_EXPIRED', refresh: true });
      vi.runAllTimers();

      expect(deps.reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a sync whose connection was lost, since its response will never arrive', async () => {
    const { $button, emit, deps, syncRequests } = setup();

    $button.click();
    await emit('vite:ws:disconnect');

    expect($button.disabled).toBe(false);
    expect($button.classList.contains('syncing')).toBe(false);
    expect(deps.closeAllConfirmModals).toHaveBeenCalled();
    expect(deps.infoPopup).toHaveBeenCalledWith(expect.objectContaining({ title: 'Sync result unknown', type: 'warning' }));

    await emit('vite:ws:connect');
    $button.click();

    expect(syncRequests()).toBe(2);
  });

  it('ignores a lost connection while no sync runs', async () => {
    const { emit, deps } = setup();

    await emit('vite:ws:disconnect');

    expect(deps.infoPopup).not.toHaveBeenCalled();
    expect(deps.closeAllConfirmModals).not.toHaveBeenCalled();
  });

  // A click while disconnected went to the outbox with the button spinning until a reconnect,
  // which then started the sync whenever it happened.
  it('refuses a click while disconnected, and takes it again once connected', async () => {
    const { $button, emit, deps, syncRequests } = setup();

    await emit('vite:ws:disconnect');
    $button.click();

    expect(syncRequests()).toBe(0);
    expect($button.disabled).toBe(false);
    expect($button.classList.contains('syncing')).toBe(false);
    expect(deps.infoPopup).toHaveBeenCalledWith(expect.objectContaining({ title: 'No connection', type: 'warning' }));

    await emit('vite:ws:connect');
    $button.click();

    expect(syncRequests()).toBe(1);
  });

  it("answers the server's confirmation request with the user's choice", async () => {
    const { $button, emit, send, deps } = setup();

    deps.confirmModal.mockResolvedValue(false);
    $button.click();
    await emit('template:sync:action-required', {
      requestId: 'r1',
      title: 'Unknown files found in backup',
      content: 'Continue?',
      confirmText: 'Continue sync',
      cancelText: 'Cancel sync',
    });

    expect(deps.confirmModal).toHaveBeenCalledWith({
      title: 'Unknown files found in backup',
      content: 'Continue?',
      confirmText: 'Continue sync',
      cancelText: 'Cancel sync',
    });
    expect(send).toHaveBeenCalledWith('template:sync:action-response', { requestId: 'r1', approved: false });
    expect($button.disabled).toBe(true);
  });

  it('starts disabled when the panel was rendered with sync unavailable, until the server allows it', async () => {
    const { $button, emit, syncRequests } = setup({ disabled: true });

    $button.click();

    expect(syncRequests()).toBe(0);

    await emit('client:config:update', { config: { canSync: true } });

    expect($button.disabled).toBe(false);

    $button.click();

    expect(syncRequests()).toBe(1);
  });
});

// Under `pp-dev next`, the first socket may still be connecting: a click went to the outbox, and if
// that attempt failed, the queued sync started on some later reconnect without another click.
describe('initSyncButton — a transport that says whether it is connected', () => {
  it('refuses a click until the socket is open', () => {
    document.body.innerHTML = '<button id="sync-template" class="sync-button" title="Sync template"></button>';

    const $button = document.getElementById('sync-template') as HTMLButtonElement;
    const send = vi.fn();
    let open = false;
    const deps = {
      infoPopup: vi.fn(),
      confirmModal: vi.fn().mockResolvedValue(true),
      closeAllConfirmModals: vi.fn(),
    } satisfies SyncButtonDeps;

    initSyncButton({ on: vi.fn(), send, isConnected: () => open } as never, $button, deps);

    $button.click();

    expect(send).not.toHaveBeenCalled();
    expect(deps.infoPopup).toHaveBeenCalledWith(expect.objectContaining({ title: 'No connection' }));

    open = true;
    $button.click();

    expect(send).toHaveBeenCalledWith('template:sync', {});
  });
});
