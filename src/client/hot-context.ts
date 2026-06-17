/// <reference types="vite/client" />
import type { ViteHotContext } from 'vite/types/hot.js';

/**
 * Minimal `import.meta.hot`-compatible context for environments without Vite HMR
 * (e.g. the `pp-dev next` server). The dev-panel client only uses `hot.on()` and
 * `hot.send()`; this shim implements those over a raw WebSocket using the same
 * custom-event wire shape Vite uses: `{ type: 'custom', event, data }`.
 *
 * Used only as a fallback: when `import.meta.hot` exists (Vite), that is used
 * instead and this code never runs.
 */

/**
 * WebSocket path the pp-dev Next.js server listens on for dev-panel messages.
 * Kept in sync with `PP_DEV_HMR_WS_PATH` in `src/constants.ts` (server side).
 */
const PP_DEV_HMR_WS_PATH = '/@pp-dev-hmr';

type CustomMessage = { type: 'custom'; event: string; data?: unknown };

type Handler = (payload: any) => void;

function resolveWebSocketUrl(): string {
  const { protocol, host } = window.location;
  const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';

  return `${wsProtocol}//${host}${PP_DEV_HMR_WS_PATH}`;
}

export function createPPDevHotContext(): ViteHotContext {
  const handlers = new Map<string, Set<Handler>>();
  /** Outgoing messages queued while the socket is not OPEN; flushed on connect. */
  const outbox: string[] = [];

  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 1_000;
  const MAX_RECONNECT_DELAY = 10_000;

  const flushOutbox = () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    while (outbox.length > 0) {
      socket.send(outbox.shift()!);
    }
  };

  const dispatch = (event: string, data: unknown) => {
    const eventHandlers = handlers.get(event);

    if (!eventHandlers) {
      return;
    }

    for (const handler of eventHandlers) {
      try {
        handler(data);
      } catch (err) {
        // A failing handler must not break dispatch to the others.
        console.error(`[pp-dev] hot handler for "${event}" failed`, err);
      }
    }
  };

  const connect = () => {
    try {
      socket = new WebSocket(resolveWebSocketUrl());
    } catch (err) {
      console.error('[pp-dev] failed to open dev-panel WebSocket', err);
      scheduleReconnect();

      return;
    }

    socket.addEventListener('open', () => {
      reconnectDelay = 1_000;
      flushOutbox();
    });

    socket.addEventListener('message', (ev) => {
      let message: CustomMessage;

      try {
        message = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }

      if (message && message.type === 'custom' && typeof message.event === 'string') {
        dispatch(message.event, message.data);
      }
    });

    socket.addEventListener('close', () => {
      socket = null;
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // `close` follows `error`; reconnect is scheduled there.
      socket?.close();
    });
  };

  const scheduleReconnect = () => {
    if (reconnectTimer) {
      return;
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      connect();
    }, reconnectDelay);
  };

  connect();

  const noop = () => {};

  const context: Pick<ViteHotContext, 'on' | 'off' | 'send'> & Partial<ViteHotContext> = {
    on(event, cb) {
      let set = handlers.get(event);

      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }

      set.add(cb as Handler);
    },
    off(event, cb) {
      handlers.get(event)?.delete(cb as Handler);
    },
    send(event, data) {
      const payload = JSON.stringify({ type: 'custom', event, data } satisfies CustomMessage);

      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      } else {
        outbox.push(payload);
      }
    },
    // Unused by the dev-panel client; provided as no-ops to satisfy the shape.
    accept: noop as ViteHotContext['accept'],
    acceptExports: noop as ViteHotContext['acceptExports'],
    dispose: noop,
    prune: noop,
    invalidate: noop,
    data: {},
  };

  return context as ViteHotContext;
}
