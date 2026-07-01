import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { PP_DEV_HMR_WS_PATH } from '../constants.js';
import { createLogger } from './logger.js';

/**
 * Raw-WebSocket transport for the dev panel under the `pp-dev next` server, where
 * Vite's HMR WebSocket is unavailable.
 *
 * It speaks the same custom-event wire shape as the client shim
 * (`src/client/hot-context.ts`): `{ type: 'custom', event, data }`, and exposes a
 * facade ({@link PPDevHotServer.ws}) matching the subset of Vite's `WebSocketServer`
 * API that {@link import('./client.service.js').ClientService} relies on
 * (`on(event, handler)` + per-client `send(event, payload)`), so the existing
 * dev-panel sync logic is reused without changes.
 */

type CustomMessage = { type: 'custom'; event: string; data?: unknown };

/** Per-connection sender handed to {@link import('./client.service.js').ClientService} handlers. */
export interface PPDevHotClient {
  send(event: string, payload?: unknown): void;
}

type EventListener = (data: any, client: PPDevHotClient) => void;
type LifecycleEvent = 'close' | 'error';

/** The subset of Vite's `WebSocketServer` surface that `ClientService` consumes. */
export interface ViteWsFacade {
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
  send(payload: unknown): void;
  send(event: string, data?: unknown): void;
}

export class PPDevHotServer {
  private readonly wss: WebSocketServer;
  private readonly eventListeners = new Map<string, Set<EventListener>>();
  private readonly lifecycleListeners = new Map<LifecycleEvent, Set<(...args: any[]) => void>>();
  private readonly clients = new Map<WebSocket, PPDevHotClient>();

  /** Stable facade instance (ClientService reads `server.ws` and stores listeners on it). */
  readonly ws: ViteWsFacade;

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (socket) => this.onConnection(socket));
    this.wss.on('error', (err) => this.fireLifecycle('error', err));

    this.ws = {
      on: (event, listener) => {
        if (event === 'close' || event === 'error') {
          this.getLifecycleSet(event).add(listener);

          return;
        }

        this.getEventSet(event).add(listener as EventListener);
      },
      off: (event, listener) => {
        this.eventListeners.get(event)?.delete(listener as EventListener);

        if (event === 'close' || event === 'error') {
          this.lifecycleListeners.get(event)?.delete(listener);
        }
      },
      send: (arg1: unknown, arg2?: unknown) => {
        // Broadcast. ClientService responds per-client and no longer broadcasts,
        // but keep this for Vite-API parity.
        if (typeof arg1 === 'string') {
          for (const socket of this.clients.keys()) {
            this.sendToSocket(socket, arg1, arg2);
          }
        } else {
          // send(payload: unknown) overload — broadcast the pre-built payload as-is.
          const data = JSON.stringify(arg1);

          for (const socket of this.clients.keys()) {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(data);
            }
          }
        }
      },
    };
  }

  /**
   * Attempt to take over an HTTP upgrade. Returns `true` when the upgrade targeted
   * the pp-dev WS path (and was handled); `false` otherwise, so the caller can let
   * another handler (e.g. Next.js HMR) process it.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const pathname = (req.url ?? '').split('?')[0];

    if (pathname !== PP_DEV_HMR_WS_PATH) {
      return false;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });

    return true;
  }

  /** Fire `close` lifecycle listeners, terminate sockets, and close the WS server. */
  async close(): Promise<void> {
    this.fireLifecycle('close');

    for (const socket of this.clients.keys()) {
      socket.terminate();
    }

    this.clients.clear();

    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private onConnection(socket: WebSocket) {
    const client: PPDevHotClient = {
      send: (event, payload) => this.sendToSocket(socket, event, payload),
    };

    this.clients.set(socket, client);

    socket.on('message', (raw) => this.onMessage(client, raw));
    socket.on('close', () => this.clients.delete(socket));
    // Per-socket errors are followed by `close`; swallow to avoid crashing the server.
    socket.on('error', () => {});
  }

  private onMessage(client: PPDevHotClient, raw: RawData) {
    let message: CustomMessage;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!message || message.type !== 'custom' || typeof message.event !== 'string') {
      return;
    }

    const listeners = this.eventListeners.get(message.event);

    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      try {
        listener(message.data, client);
      } catch (err) {
        createLogger().error(`ws handler for "${message.event}" failed`, {
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  }

  private sendToSocket(socket: WebSocket, event: string, payload?: unknown) {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify({ type: 'custom', event, data: payload } satisfies CustomMessage));
  }

  private fireLifecycle(type: LifecycleEvent, arg?: unknown) {
    for (const listener of this.lifecycleListeners.get(type) ?? []) {
      try {
        listener(arg);
      } catch {
        // ignore
      }
    }
  }

  private getEventSet(event: string): Set<EventListener> {
    let set = this.eventListeners.get(event);

    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }

    return set;
  }

  private getLifecycleSet(event: LifecycleEvent): Set<(...args: any[]) => void> {
    let set = this.lifecycleListeners.get(event);

    if (!set) {
      set = new Set();
      this.lifecycleListeners.set(event, set);
    }

    return set;
  }
}
