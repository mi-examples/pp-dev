// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPPDevHotContext } from '../../../src/client/hot-context.js';
import { PP_DEV_HMR_WS_PATH } from '../../../src/constants.js';

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

  // The panel only knew of a lost connection, so with a server that was down when the page
  // loaded, a click queued its sync until some later reconnect.
  it('emits vite:ws:disconnect once when the first connection never opens', () => {
    const hot = createPPDevHotContext();
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();

    hot.on('vite:ws:connect', onConnect);
    hot.on('vite:ws:disconnect', onDisconnect);

    FakeWebSocket.instances[0]!.fireClose();
    vi.advanceTimersByTime(1_000);
    FakeWebSocket.instances[1]!.fireClose();

    expect(onDisconnect).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    FakeWebSocket.instances[2]!.fireOpen();

    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('says it is connected only while the socket is open', () => {
    const hot = createPPDevHotContext();

    expect(hot.isConnected()).toBe(false);

    FakeWebSocket.instances[0]!.fireOpen();
    expect(hot.isConnected()).toBe(true);

    FakeWebSocket.instances[0]!.fireClose();
    expect(hot.isConnected()).toBe(false);
  });

  it('connects to the path the pp-dev next server listens on', () => {
    createPPDevHotContext();

    expect(new URL(FakeWebSocket.instances[0]!.url).pathname).toBe(PP_DEV_HMR_WS_PATH);
  });
});

describe('createPPDevHotContext reconnect and outbox', () => {
  const socket = (index: number) => FakeWebSocket.instances[index]!;
  const sentEvents = (ws: FakeWebSocket) => ws.sent.map((raw) => (JSON.parse(raw) as { event: string }).event);

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reconnects after 1 s, then waits twice as long each time, up to 10 s', () => {
    createPPDevHotContext();

    const waits: number[] = [];

    for (let attempt = 0; attempt < 6; attempt++) {
      const count = FakeWebSocket.instances.length;

      socket(count - 1).fireClose();

      let waited = 0;

      while (FakeWebSocket.instances.length === count) {
        vi.advanceTimersByTime(500);
        waited += 500;
      }

      waits.push(waited);
    }

    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
  });

  it('starts over at 1 s once a connection opens', () => {
    createPPDevHotContext();

    socket(0).fireClose();
    vi.advanceTimersByTime(1_000);
    socket(1).fireClose();
    vi.advanceTimersByTime(2_000);
    socket(2).fireOpen();
    socket(2).fireClose();
    vi.advanceTimersByTime(999);

    expect(FakeWebSocket.instances).toHaveLength(3);

    vi.advanceTimersByTime(1);

    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('reconnects when an error closes the socket', () => {
    createPPDevHotContext();

    socket(0).dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(1_000);

    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('retries when the WebSocket cannot even be created', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;

    vi.stubGlobal(
      'WebSocket',
      class extends FakeWebSocket {
        constructor(url: string) {
          if (fail) {
            fail = false;
            throw new Error('blocked');
          }

          super(url);
        }
      },
    );

    createPPDevHotContext();

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(error).toHaveBeenCalledWith('[pp-dev] failed to open dev-panel WebSocket', expect.any(Error));

    vi.advanceTimersByTime(1_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('queues messages sent before the socket opens and sends them in order once it does', () => {
    const hot = createPPDevHotContext();

    hot.send('first', {});
    hot.send('second', {});

    expect(socket(0).sent).toEqual([]);

    socket(0).fireOpen();

    expect(sentEvents(socket(0))).toEqual(['first', 'second']);

    hot.send('third', { n: 3 });

    expect(JSON.parse(socket(0).sent[2]!)).toEqual({ type: 'custom', event: 'third', data: { n: 3 } });
  });

  it('keeps queued messages across a reconnect and sends them on the new socket', () => {
    const hot = createPPDevHotContext();

    socket(0).fireOpen();
    socket(0).fireClose();
    hot.send('while-down', {});
    vi.advanceTimersByTime(1_000);
    socket(1).fireOpen();

    expect(sentEvents(socket(0))).toEqual([]);
    expect(sentEvents(socket(1))).toEqual(['while-down']);
  });

  it('keeps only the 50 newest queued messages', () => {
    const hot = createPPDevHotContext();

    for (let i = 0; i < 60; i++) {
      hot.send(`m${i}`, {});
    }

    socket(0).fireOpen();

    expect(sentEvents(socket(0))).toEqual(Array.from({ length: 50 }, (_, i) => `m${i + 10}`));
  });
});

describe('createPPDevHotContext incoming messages', () => {
  const message = (data: unknown) => new MessageEvent('message', { data });

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('passes custom events to their handlers, and ignores anything else', () => {
    const hot = createPPDevHotContext();
    const onSync = vi.fn();

    hot.on('template:sync:response', onSync);

    const ws = FakeWebSocket.instances[0]!;

    ws.dispatchEvent(message(JSON.stringify({ type: 'custom', event: 'template:sync:response', data: { ok: 1 } })));
    ws.dispatchEvent(message('not json'));
    ws.dispatchEvent(message(JSON.stringify({ type: 'full-reload' })));
    ws.dispatchEvent(message(JSON.stringify({ type: 'custom', event: 42 })));
    ws.dispatchEvent(message(new Blob(['{}'])));

    expect(onSync).toHaveBeenCalledTimes(1);
    expect(onSync).toHaveBeenCalledWith({ ok: 1 });
  });

  it('still calls the other handlers when one throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hot = createPPDevHotContext();
    const after = vi.fn();

    hot.on('info-data:response', () => {
      throw new Error('boom');
    });
    hot.on('info-data:response', after);

    FakeWebSocket.instances[0]!.dispatchEvent(
      message(JSON.stringify({ type: 'custom', event: 'info-data:response', data: 1 })),
    );

    expect(after).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith('[pp-dev] hot handler for "info-data:response" failed', expect.any(Error));
  });

  it('stops calling a handler removed with off()', () => {
    const hot = createPPDevHotContext();
    const handler = vi.fn();

    hot.on('info-data:response', handler);
    hot.off('info-data:response', handler);

    FakeWebSocket.instances[0]!.dispatchEvent(
      message(JSON.stringify({ type: 'custom', event: 'info-data:response', data: 1 })),
    );

    expect(handler).not.toHaveBeenCalled();
  });
});
