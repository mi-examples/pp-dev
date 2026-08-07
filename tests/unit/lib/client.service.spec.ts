import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ViteDevServer, WebSocketClient } from 'vite';
import { ClientService } from '../../../src/lib/client.service.js';
import type { DistService } from '../../../src/lib/dist.service.js';
import type { MiAPI } from '../../../src/lib/pp.middleware.js';

/**
 * Regression tests for the WebSocket "broadcast to all clients" bug.
 *
 * The dev panel previously responded via `server.ws.send()`, which Vite
 * broadcasts to every connected client. Each response must instead be sent
 * only to the `WebSocketClient` that triggered the request.
 */
describe('ClientService — targeted WebSocket responses', () => {
  const handlers = new Map<string, (...args: any[]) => void>();
  let server: ViteDevServer;

  function makeClient(): WebSocketClient {
    return { send: vi.fn() } as unknown as WebSocketClient;
  }

  beforeEach(() => {
    handlers.clear();

    server = {
      ws: {
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
          handlers.set(event, handler);
        }),
        send: vi.fn(),
      },
      config: { clientInjectionPlugin: { v7Features: false } },
    } as unknown as ViteDevServer;

    // Registers handlers on server.ws via init()
    new ClientService(server);
  });

  it('replies to info-data:request on the requesting client only', () => {
    const sender = makeClient();
    const other = makeClient();

    handlers.get('info-data:request')!({}, sender);

    expect(sender.send).toHaveBeenCalledWith('info-data:response', {});
    expect(other.send).not.toHaveBeenCalled();
  });

  it('never broadcasts via server.ws.send for info-data:request', () => {
    handlers.get('info-data:request')!({}, makeClient());

    expect(server.ws.send).not.toHaveBeenCalled();
  });

  it('sends template:sync error to the requesting client only (no dist service)', async () => {
    const sender = makeClient();
    const other = makeClient();

    // No distService / miAPI configured → error path
    await handlers.get('template:sync')!({}, sender);

    expect(sender.send).toHaveBeenCalledWith('template:sync:response', {
      error: 'Dist service or MiAPI is not defined',
    });
    expect(other.send).not.toHaveBeenCalled();
    expect(server.ws.send).not.toHaveBeenCalled();
  });
});

describe('ClientService — page-variables:reload', () => {
  const handlers = new Map<string, (...args: any[]) => void>();
  let server: ViteDevServer;

  function makeClient(): WebSocketClient {
    return { send: vi.fn() } as unknown as WebSocketClient;
  }

  beforeEach(() => {
    handlers.clear();

    server = {
      ws: {
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
          handlers.set(event, handler);
        }),
        send: vi.fn(),
      },
      config: { clientInjectionPlugin: { v7Features: false } },
    } as unknown as ViteDevServer;
  });

  it('errors when miAPI is not configured', async () => {
    new ClientService(server);

    const client = makeClient();

    await handlers.get('page-variables:reload')!({}, client);

    expect(client.send).toHaveBeenCalledWith('page-variables:reload:response', {
      error: 'MiAPI is not defined',
    });
  });

  it('reports the refetched count on success', async () => {
    const miAPI = {
      reloadPageVariables: vi.fn().mockResolvedValue([{ name: 'title', value: 'Hello' }]),
    } as unknown as MiAPI;

    new ClientService(server, { miAPI });

    const client = makeClient();

    await handlers.get('page-variables:reload')!({}, client);

    expect(client.send).toHaveBeenCalledWith('page-variables:reload:response', {
      ok: true,
      count: 1,
      skipped: false,
    });
  });

  it('reports skipped:true for a templateLess page (reloadPageVariables resolves null)', async () => {
    const miAPI = {
      reloadPageVariables: vi.fn().mockResolvedValue(null),
    } as unknown as MiAPI;

    new ClientService(server, { miAPI });

    const client = makeClient();

    await handlers.get('page-variables:reload')!({}, client);

    expect(client.send).toHaveBeenCalledWith('page-variables:reload:response', {
      ok: true,
      count: 0,
      skipped: true,
    });
  });

  it('sends an error response when reloadPageVariables throws', async () => {
    const miAPI = {
      reloadPageVariables: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as MiAPI;

    new ClientService(server, { miAPI });

    const client = makeClient();

    await handlers.get('page-variables:reload')!({}, client);

    expect(client.send).toHaveBeenCalledWith('page-variables:reload:response', {
      error: 'boom',
    });
  });
});
