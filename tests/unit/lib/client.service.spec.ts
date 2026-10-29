import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ViteDevServer, WebSocketClient } from 'vite';
import { ClientService } from '../../../src/lib/client.service.js';
import type { BackupAnalysis, DistService } from '../../../src/lib/dist.service.js';
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
    expect(first.send).not.toHaveBeenCalledWith(
      'template:sync:response',
      expect.objectContaining({ code: 'SYNC_IN_PROGRESS' }),
    );
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

/**
 * A tab closed while a sync's dialog is open never answers it: the sync waited for the 120 s timeout,
 * and every other sync was refused as "already running" meanwhile. And a build the sync started
 * outlived the dev server.
 */
describe('ClientService — dialogs and builds when connections close', () => {
  const handlers = new Map<string, (...args: any[]) => void>();
  let service: ClientService;
  let stopBuilds: ReturnType<typeof vi.fn>;

  function makeSocket(readyState = 1) {
    return Object.assign(new EventEmitter(), { readyState, OPEN: 1 });
  }

  beforeEach(() => {
    handlers.clear();
    stopBuilds = vi.fn();

    const server = {
      ws: {
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
          handlers.set(event, handler);
        }),
        send: vi.fn(),
      },
      config: { clientInjectionPlugin: { v7Features: false } },
    } as unknown as ViteDevServer;

    service = new ClientService(server, {
      distService: { stopBuilds } as unknown as DistService,
      syncActionTimeoutMs: 60_000,
    });
  });

  const dialog = { title: 't', content: 'c', confirmText: 'ok', cancelText: 'no' };

  it("cancels a dialog at once when its tab's connection closes", async () => {
    const socket = makeSocket();
    const client = { send: vi.fn(), socket } as unknown as WebSocketClient;
    const answer = service.requestSyncAction(dialog, client);

    expect(client.send).toHaveBeenCalledWith('template:sync:action-required', expect.objectContaining(dialog));

    socket.emit('close');

    await expect(answer).resolves.toBe(false);
  });

  it('cancels a dialog for a connection that is already closed, without sending it', async () => {
    const client = { send: vi.fn(), socket: makeSocket(3) } as unknown as WebSocketClient;

    await expect(service.requestSyncAction(dialog, client)).resolves.toBe(false);
    expect(client.send).not.toHaveBeenCalled();
  });

  it('stops listening to the connection once the dialog is answered', async () => {
    const socket = makeSocket();
    const client = { send: vi.fn(), socket } as unknown as WebSocketClient;
    const answer = service.requestSyncAction(dialog, client);
    const { requestId } = (client.send as ReturnType<typeof vi.fn>).mock.calls[0][1];

    expect(socket.listenerCount('close')).toBe(1);

    handlers.get('template:sync:action-response')!({ requestId, approved: true });

    await expect(answer).resolves.toBe(true);
    expect(socket.listenerCount('close')).toBe(0);
  });

  it('stops running builds and cancels open dialogs when disposed with the dev server', async () => {
    const client = { send: vi.fn(), socket: makeSocket() } as unknown as WebSocketClient;
    const answer = service.requestSyncAction(dialog, client);

    service.dispose();

    expect(stopBuilds).toHaveBeenCalledTimes(1);
    await expect(answer).resolves.toBe(false);
  });

  // Vite takes `ws.on('close')` for a custom message any page can send, and never calls it on
  // shutdown: a page could stop every build with it, and the server's own close never did.
  it('does not listen for a `close` message on the WebSocket', () => {
    expect(handlers.has('close')).toBe(false);
  });
});

/**
 * A page with no assets on MI yet syncs without saving a backup, so the sync meta is still `{}`.
 * Converting its missing date threw `RangeError: Invalid time value` after the upload had succeeded,
 * and the panel was told the sync failed.
 */
describe('ClientService — a sync before any backup was saved', () => {
  it('reports success, dated now', async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const server = {
      ws: {
        on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
        send: vi.fn(),
      },
      config: { clientInjectionPlugin: { v7Features: false } },
    } as unknown as ViteDevServer;
    const distService = {
      buildNewAssets: vi.fn().mockResolvedValue(Buffer.from('zip')),
      getBackupMeta: vi.fn(() => ({})),
    } as unknown as DistService;
    const miAPI = {
      getAssets: vi.fn().mockResolvedValue(undefined),
      updateAssets: vi.fn().mockResolvedValue({ status: 'OK' }),
    } as unknown as MiAPI;
    const client = { send: vi.fn() } as unknown as WebSocketClient;
    const before = Date.now();

    new ClientService(server, { distService, miAPI });
    await handlers.get('template:sync')!({}, client);

    const [event, payload] = (client.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;

    expect(event).toBe('template:sync:response');
    expect(payload).toEqual({ syncedAt: expect.any(String), currentHash: '', backupFilename: '' });
    expect(Date.parse(payload.syncedAt)).toBeGreaterThanOrEqual(before - 1000);
  });
});

/** A build that finished as the dev server was shutting down (or restarting) was still uploaded. */
describe('ClientService — a sync whose dev server stopped after the build', () => {
  it('uploads nothing and says why', async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const server = {
      ws: {
        on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
        send: vi.fn(),
      },
      config: { clientInjectionPlugin: { v7Features: false } },
    } as unknown as ViteDevServer;
    const distService = {
      buildNewAssets: vi.fn().mockResolvedValue(Buffer.from('zip')),
      getBackupMeta: vi.fn(() => ({})),
      stopped: true,
    } as unknown as DistService;
    const miAPI = {
      getAssets: vi.fn().mockResolvedValue(undefined),
      updateAssets: vi.fn().mockResolvedValue({ status: 'OK' }),
    } as unknown as MiAPI;
    const client = { send: vi.fn() } as unknown as WebSocketClient;

    new ClientService(server, { distService, miAPI });
    await handlers.get('template:sync')!({}, client);

    expect(miAPI.updateAssets).not.toHaveBeenCalled();
    expect(client.send).toHaveBeenLastCalledWith('template:sync:response', {
      error: 'Sync stopped: the dev server is shutting down.',
    });
  });
});

/** What the panel is asked and told during a sync of a page that has assets on MI already. */
describe('ClientService — sync dialogs, cancel and build errors', () => {
  const cleanAnalysis = (): BackupAnalysis => ({
    backupFingerprint: 'fp',
    unknownFiles: [],
    templateVariables: null,
    mainHash: 'main',
    allFilesInMeta: true,
    buildManifestMismatch: null,
    versionManifestHashMismatches: [],
  });

  function setup(opts: { analysis?: () => Promise<BackupAnalysis>; answers?: boolean[]; build?: () => unknown }) {
    const handlers = new Map<string, (...args: any[]) => any>();
    const server = {
      ws: {
        on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
        send: vi.fn(),
      },
      config: { clientInjectionPlugin: { v7Features: false } },
    } as unknown as ViteDevServer;
    const answers = [...(opts.answers ?? [])];
    const dialogs: Array<{ title: string; content: string }> = [];
    const responses: unknown[] = [];
    const client = {
      send: vi.fn((event: string, payload: any) => {
        if (event === 'template:sync:action-required') {
          dialogs.push(payload);
          // The panel answers on a later turn, as a WebSocket message would arrive.
          setTimeout(() =>
            handlers.get('template:sync:action-response')!({ requestId: payload.requestId, approved: answers.shift() }),
          );
        }

        if (event === 'template:sync:response') {
          responses.push(payload);
        }
      }),
    } as unknown as WebSocketClient;
    const distService = {
      analyzeBackup: vi.fn(opts.analysis ?? (async () => cleanAnalysis())),
      saveBackup: vi.fn().mockResolvedValue(undefined),
      buildNewAssets: vi.fn(opts.build ?? (async () => Buffer.from('zip'))),
      getBackupMeta: vi.fn(() => ({
        lastBackupName: 'b.zip',
        lastBackupHash: 'h',
        lastBackupDate: '2026-10-29T08:00:00.000Z',
      })),
      getPublicTemplateVariablesHash: vi.fn().mockResolvedValue('local-hash'),
      saveTemplateVariablesFile: vi.fn().mockResolvedValue(undefined),
      stopped: false,
    } as unknown as DistService;
    const miAPI = {
      getAssets: vi.fn().mockResolvedValue(Buffer.from('current')),
      updateAssets: vi.fn().mockResolvedValue({ status: 'OK' }),
    } as unknown as MiAPI;

    new ClientService(server, { distService, miAPI, syncActionTimeoutMs: 5_000 });

    const sync = () => handlers.get('template:sync')!({}, client) as Promise<void>;

    return { sync, dialogs, responses, distService, miAPI };
  }

  const cancelled = { cancelled: true, message: 'Sync cancelled by user. Backup was saved.' };
  const synced = { syncedAt: '2026-10-29T08:00:00.000Z', currentHash: 'h', backupFilename: 'b.zip' };

  it('saves the backup and uploads without a dialog when the backup matches its manifests', async () => {
    const { sync, dialogs, responses, distService, miAPI } = setup({});

    await sync();

    expect(distService.saveBackup).toHaveBeenCalledWith(Buffer.from('current'), expect.any(Object));
    expect(dialogs).toEqual([]);
    expect(miAPI.updateAssets).toHaveBeenCalledWith(Buffer.from('zip'));
    expect(responses).toEqual([synced]);
  });

  it('asks about files missing from VERSION, and stops there when the answer is cancel', async () => {
    const { sync, dialogs, responses, distService, miAPI } = setup({
      analysis: async () => ({ ...cleanAnalysis(), unknownFiles: ['extra.js', 'old.css'] }),
      answers: [false],
    });

    await sync();

    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toMatchObject({ title: 'Unknown files found in backup' });
    expect(dialogs[0]!.content).toContain('extra.js, old.css');
    expect(distService.saveBackup).toHaveBeenCalled();
    expect(distService.buildNewAssets).not.toHaveBeenCalled();
    expect(miAPI.updateAssets).not.toHaveBeenCalled();
    expect(responses).toEqual([cancelled]);
  });

  it('builds and uploads when the answer is continue', async () => {
    const { sync, responses, miAPI } = setup({
      analysis: async () => ({ ...cleanAnalysis(), unknownFiles: ['extra.js'] }),
      answers: [true],
    });

    await sync();

    expect(miAPI.updateAssets).toHaveBeenCalled();
    expect(responses).toEqual([synced]);
  });

  it('lists the files that no longer match VERSION, at most 40, and can be cancelled', async () => {
    const mismatches = Array.from({ length: 42 }, (_, i) => ({ relativePath: `f${i}.js`, expected: 'a', actual: 'b' }));
    const { sync, dialogs, responses, distService } = setup({
      analysis: async () => ({ ...cleanAnalysis(), versionManifestHashMismatches: mismatches }),
      answers: [false],
    });

    await sync();

    expect(dialogs[0]).toMatchObject({ title: 'VERSION manifest out of date', confirmText: 'Override and continue' });
    expect(dialogs[0]!.content).toContain('• f39.js');
    expect(dialogs[0]!.content).not.toContain('• f40.js');
    expect(dialogs[0]!.content).toContain('... and 2 more files');
    expect(distService.buildNewAssets).not.toHaveBeenCalled();
    expect(responses).toEqual([cancelled]);
  });

  it('asks about a BUILD-MANIFEST fingerprint mismatch only when VERSION had no per-file mismatch', async () => {
    const buildManifestMismatch = { expected: 'e'.repeat(64), actual: 'a'.repeat(64) };
    const alone = setup({
      analysis: async () => ({ ...cleanAnalysis(), buildManifestMismatch }),
      answers: [false],
    });

    await alone.sync();

    expect(alone.dialogs.map((d) => d.title)).toEqual(['Build manifest fingerprint mismatch']);
    expect(alone.dialogs[0]!.content).toContain('Manifest: eeeeeeeeeeee...');
    expect(alone.responses).toEqual([cancelled]);

    const withVersion = setup({
      analysis: async () => ({
        ...cleanAnalysis(),
        buildManifestMismatch,
        versionManifestHashMismatches: [{ relativePath: 'a.js', expected: 'a', actual: 'b' }],
      }),
      answers: [true],
    });

    await withVersion.sync();

    expect(withVersion.dialogs.map((d) => d.title)).toEqual(['VERSION manifest out of date']);
    expect(withVersion.responses).toEqual([synced]);
  });

  describe('template variables in the server backup', () => {
    const templateVariables = {
      relativePath: '__template_variables.json',
      content: Buffer.from('{"server":true}'),
      actualHash: 'server-hash',
      manifestHash: 'manifest-hash',
    };
    const templateVariablesMismatch = {
      relativePath: '__template_variables.json',
      expected: 'manifest-hash',
      actual: 'server-hash',
    };
    const onlyTemplateVariables = async (): Promise<BackupAnalysis> => ({
      ...cleanAnalysis(),
      templateVariables,
      versionManifestHashMismatches: [templateVariablesMismatch],
    });

    it('replaces the local copy when asked to, and syncs on', async () => {
      const { sync, dialogs, responses, distService } = setup({ analysis: onlyTemplateVariables, answers: [true] });

      await sync();

      expect(dialogs.map((d) => d.title)).toEqual(['Template variables (server backup)']);
      expect(distService.saveTemplateVariablesFile).toHaveBeenCalledWith(templateVariables.content);
      expect(responses).toEqual([synced]);
    });

    it('keeps the local copy when asked to, and syncs on', async () => {
      const { sync, responses, distService } = setup({ analysis: onlyTemplateVariables, answers: [false] });

      await sync();

      expect(distService.saveTemplateVariablesFile).not.toHaveBeenCalled();
      expect(responses).toEqual([synced]);
    });

    it('does not ask when the local copy already matches the server one', async () => {
      const { sync, dialogs, distService } = setup({ analysis: onlyTemplateVariables });

      vi.mocked(distService.getPublicTemplateVariablesHash).mockResolvedValue('server-hash');
      await sync();

      expect(dialogs).toEqual([]);
    });

    it('asks about template variables first, then about the other files', async () => {
      const { sync, dialogs } = setup({
        analysis: async () => ({
          ...cleanAnalysis(),
          templateVariables,
          versionManifestHashMismatches: [
            templateVariablesMismatch,
            { relativePath: 'app.js', expected: 'a', actual: 'b' },
          ],
        }),
        answers: [false, true],
      });

      await sync();

      expect(dialogs.map((d) => d.title)).toEqual([
        'Template variables (server backup)',
        'VERSION manifest out of date',
      ]);
      expect(dialogs[1]!.content).toContain('• app.js');
      expect(dialogs[1]!.content).not.toContain('__template_variables.json');
    });
  });

  describe('build and upload errors', () => {
    it('reports the error a failed build returns', async () => {
      const { sync, responses, miAPI } = setup({ build: async () => new Error('next build exited with code 1') });

      await sync();

      expect(miAPI.updateAssets).not.toHaveBeenCalled();
      expect(responses).toEqual([{ error: 'next build exited with code 1' }]);
    });

    it('reports a build that returned nothing', async () => {
      const { sync, responses } = setup({ build: async () => undefined });

      await sync();

      expect(responses).toEqual([{ error: 'Failed to build new assets' }]);
    });

    it('reports a build that threw, as a failed sync', async () => {
      const { sync, responses } = setup({
        build: async () => {
          throw new Error('spawn ENOENT');
        },
      });

      await sync();

      expect(responses).toEqual([{ error: 'spawn ENOENT', code: 'SYNC_FAILED' }]);
    });

    it('reports a backup that could not be read, without building', async () => {
      const { sync, responses, distService } = setup({
        analysis: async () => {
          throw new Error('Backup file is not a ZIP file');
        },
      });

      await sync();

      expect(distService.buildNewAssets).not.toHaveBeenCalled();
      expect(responses).toEqual([{ error: 'Backup file is not a ZIP file' }]);
    });

    it('reports an upload MI did not accept', async () => {
      const { sync, responses, miAPI } = setup({});

      vi.mocked(miAPI.updateAssets).mockResolvedValue({ status: 'ERROR' } as never);
      await sync();

      expect(responses).toEqual([{ error: 'Failed to update assets' }]);
    });
  });
});
