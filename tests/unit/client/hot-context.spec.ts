// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPPDevHotContext } from '../../../src/client/hot-context.js';

/**
 * The raw-WebSocket stand-in for `import.meta.hot` under `pp-dev next` emits Vite's own
 * connection events, so the dev panel can end a sync whose response will never arrive.
 */

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.fireClose();
  }

  fireOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  fireClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
}

describe('createPPDevHotContext connection events', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('emits vite:ws:connect when the socket opens and vite:ws:disconnect when it closes', () => {
    const hot = createPPDevHotContext();
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();

    hot.on('vite:ws:connect', onConnect);
    hot.on('vite:ws:disconnect', onDisconnect);

    FakeWebSocket.instances[0]!.fireOpen();

    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).not.toHaveBeenCalled();

    FakeWebSocket.instances[0]!.fireClose();

    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('does not emit vite:ws:disconnect again for reconnect attempts that never opened', () => {
    const hot = createPPDevHotContext();
    const onDisconnect = vi.fn();

    hot.on('vite:ws:disconnect', onDisconnect);

    FakeWebSocket.instances[0]!.fireOpen();
    FakeWebSocket.instances[0]!.fireClose();
    vi.advanceTimersByTime(1_000);
    FakeWebSocket.instances[1]!.fireClose();
    vi.advanceTimersByTime(2_000);
    FakeWebSocket.instances[2]!.fireClose();

    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});
