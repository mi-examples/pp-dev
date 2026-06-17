import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocket } from 'ws';
import type { ViteDevServer } from 'vite';
import { PPDevHotServer } from '../../../src/lib/pp-ws-server.js';
import { ClientService } from '../../../src/lib/client.service.js';

/**
 * End-to-end test of the Next.js dev-panel transport: a raw WebSocket talking to
 * PPDevHotServer, with the existing ClientService reused unchanged via the
 * Vite-WS-compatible facade. Also verifies the bug-1 guarantee (responses go only
 * to the requesting client) holds over this transport.
 */
describe('PPDevHotServer transport', () => {
  let server: Server;
  let hotServer: PPDevHotServer;
  let port: number;

  beforeEach(async () => {
    hotServer = new PPDevHotServer();

    // Reuse ClientService unchanged through the facade.
    const clientServiceServer = {
      ws: hotServer.ws,
      config: { clientInjectionPlugin: { v7Features: false } },
    } as unknown as ViteDevServer;

    new ClientService(clientServiceServer);

    server = createServer();
    server.on('upgrade', (req, socket, head) => {
      if (!hotServer.handleUpgrade(req, socket, head)) {
        socket.destroy();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));

    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  afterEach(async () => {
    await hotServer.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function connect(path = '/@pp-dev-hmr'): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}${path}`);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  function nextMessage(ws: WebSocket, timeoutMs = 1000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);

      ws.once('message', (raw) => {
        clearTimeout(timer);
        resolve(JSON.parse(raw.toString()));
      });
    });
  }

  function send(ws: WebSocket, event: string, data?: unknown) {
    ws.send(JSON.stringify({ type: 'custom', event, data }));
  }

  it('routes a request to ClientService and replies on the same socket', async () => {
    const ws = await connect();

    try {
      send(ws, 'info-data:request', {});

      const message = await nextMessage(ws);

      expect(message).toEqual({ type: 'custom', event: 'info-data:response', data: {} });
    } finally {
      ws.close();
    }
  });

  it('replies only to the requesting client, not other connected clients', async () => {
    const sender = await connect();
    const other = await connect();

    let otherReceived = false;
    other.on('message', () => {
      otherReceived = true;
    });

    try {
      send(sender, 'info-data:request', {});

      const message = await nextMessage(sender);

      expect(message.event).toBe('info-data:response');
      expect(otherReceived).toBe(false);
    } finally {
      sender.close();
      other.close();
    }
  });

  it('sends template:sync error to the requesting client when sync is unavailable', async () => {
    const ws = await connect();

    try {
      send(ws, 'template:sync', {});

      const message = await nextMessage(ws);

      expect(message.event).toBe('template:sync:response');
      expect(message.data.error).toBe('Dist service or MiAPI is not defined');
    } finally {
      ws.close();
    }
  });

  it('rejects upgrades on non pp-dev paths', async () => {
    await expect(connect('/_next/webpack-hmr')).rejects.toBeTruthy();
  });
});
