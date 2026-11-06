// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { initReloadVariables } from '../../../src/client/reload-variables.js';

/**
 * The dev panel's "Reload variables" action.
 *
 * It was sent whatever the connection: both transports keep a message until the socket is back,
 * so the "Reloading variables" popup, which stays until an answer, stayed until a reconnect — and
 * the page then reloaded on its own, unasked.
 */

type Handler = (payload: any) => unknown;

function setup({ connected = true }: { connected?: boolean } = {}) {
  const handlers = new Map<string, Handler[]>();
  const send = vi.fn();
  const hot = {
    on(event: string, cb: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), cb]);
    },
    send,
    isConnected: () => connected,
  };
  const popups: Array<{ title?: string; close: ReturnType<typeof vi.fn> }> = [];
  const infoPopup = vi.fn((opts: { title?: string }) => {
    const popup = { title: opts.title, close: vi.fn() };

    popups.push(popup);

    return popup;
  });
  const reload = vi.fn();
  const start = initReloadVariables(hot as never, { infoPopup, reload });
  const emit = (event: string, payload: unknown = {}) => (handlers.get(event) ?? []).forEach((cb) => cb(payload));

  return { start, send, emit, popups, reload };
}

describe('initReloadVariables', () => {
  it('asks the dev server, and reloads the page once it answers', () => {
    vi.useFakeTimers();

    const { start, send, emit, popups, reload } = setup();

    start();

    expect(send).toHaveBeenCalledWith('page-variables:reload', {});
    expect(popups[0]!.title).toBe('Reloading variables');

    emit('page-variables:reload:response', { ok: true, count: 3, skipped: false });

    expect(popups[0]!.close).toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(reload).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('says so instead of sending while the dev server is not connected', () => {
    const { start, send, popups } = setup({ connected: false });

    start();

    expect(send).not.toHaveBeenCalled();
    expect(popups.map((p) => p.title)).toEqual(['No connection']);
  });

  it('says so instead of sending once the connection was reported lost', () => {
    const { start, send, emit, popups } = setup();

    emit('vite:ws:disconnect');
    start();

    expect(send).not.toHaveBeenCalled();
    expect(popups.map((p) => p.title)).toEqual(['No connection']);

    emit('vite:ws:connect');
    start();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ends the wait when the connection is lost, and does not reload on a later answer', () => {
    vi.useFakeTimers();

    const { start, emit, popups, reload } = setup();

    start();
    emit('vite:ws:disconnect');

    expect(popups[0]!.close).toHaveBeenCalled();
    expect(popups[1]!.title).toBe('Reload variables interrupted');

    vi.advanceTimersByTime(1000);
    expect(reload).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
