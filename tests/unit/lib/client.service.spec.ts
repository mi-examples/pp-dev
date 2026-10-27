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

/**
 * Regression tests for parallel template syncs: a double click, a second tab, or a click the
 * panel replayed after a reconnect started a second build into the same output folder and a
 * second upload to MI while the first was still running.
 */
describe('ClientService — one template sync at a time', () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let server: ViteDevServer;

  function makeClient(): WebSocketClient {
    return { send: vi.fn() } as unknown as WebSocketClient;
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    return { promise, resolve, reject };
  }

  function setup() {
    const builds: Array<ReturnType<typeof deferred<Buffer>>> = [];
    const distService = {
      buildNewAssets: vi.fn(() => {
        const build = deferred<Buffer>();

        builds.push(build);

        return build.promise;
      }),
      getBackupMeta: vi.fn(() => ({
        lastBackupName: 'backup.zip',
        lastBackupHash: 'hash',
        lastBackupDate: '2026-10-27T10:00:00.000Z',
      })),
    } as unknown as DistService;
    const miAPI = {
      // No current assets on MI: the sync goes straight to the build.
      getAssets: vi.fn().mockResolvedValue(undefined),
      updateAssets: vi.fn().mockResolvedValue({ status: 'OK' }),
    } as unknown as MiAPI;

    new ClientService(server, { distService, miAPI });

    return { distService, miAPI, builds };
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    handlers.clear();

    server = {
      ws: {
        on: vi.fn((event: string, handler: (...args: any[]) => any) => {
          handlers.set(event, handler);
        }),
        send: vi.fn(),
      },
      config: { clientInjectionPlugin: { v7Features: false } },
    } as unknown as ViteDevServer;
  });

  it('answers a second request while a sync runs, without building or uploading again', async () => {
    const { distService, miAPI, builds } = setup();
    const first = makeClient();
    const second = makeClient();

    const firstSync = handlers.get('template:sync')!({}, first);

    await flush();
    await handlers.get('template:sync')!({}, second);

    expect(distService.buildNewAssets).toHaveBeenCalledTimes(1);
    expect(second.send).toHaveBeenCalledWith('template:sync:response', {
      error: expect.stringContaining('already running'),
      code: 'SYNC_IN_PROGRESS',
    });

    builds[0]!.resolve(Buffer.from('zip'));
    await firstSync;

    expect(miAPI.updateAssets).toHaveBeenCalledTimes(1);
    expect(first.send).toHaveBeenCalledWith(
      'template:sync:response',
      expect.objectContaining({ backupFilename: 'backup.zip' }),
    );
    expect(first.send).not.toHaveBeenCalledWith('template:sync:response', expect.objectContaining({ code: 'SYNC_IN_PROGRESS' }));
  });

  it('runs the next sync once the previous one has finished', async () => {
    const { distService, builds } = setup();
    const client = makeClient();

    const firstSync = handlers.get('template:sync')!({}, client);

    await flush();
    builds[0]!.resolve(Buffer.from('zip'));
    await firstSync;

    const secondSync = handlers.get('template:sync')!({}, client);

    await flush();

    expect(distService.buildNewAssets).toHaveBeenCalledTimes(2);

    builds[1]!.resolve(Buffer.from('zip'));
    await secondSync;
  });

  it('runs the next sync after the previous one failed', async () => {
    const { distService, builds } = setup();
    const client = makeClient();

    const firstSync = handlers.get('template:sync')!({}, client);

    await flush();
    builds[0]!.reject(new Error('build command exited with code 1'));
    await firstSync;

    expect(client.send).toHaveBeenCalledWith('template:sync:response', {
      error: 'build command exited with code 1',
      code: 'SYNC_FAILED',
    });

    const secondSync = handlers.get('template:sync')!({}, client);

    await flush();

    expect(distService.buildNewAssets).toHaveBeenCalledTimes(2);

    builds[1]!.resolve(Buffer.from('zip'));
    await secondSync;
  });
});
