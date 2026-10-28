import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ViteDevServer } from 'vite';
import { bindShortcuts, interruptProcess } from '../../../src/shortcuts.js';

describe('interruptProcess (Ctrl+C typed while shortcuts hold stdin in raw mode)', () => {
  const fakeProcess = (platform: NodeJS.Platform) => ({ platform, pid: 4242, kill: vi.fn(), emit: vi.fn() });

  it('emits SIGINT on Windows, where process.kill would terminate without running any handler', () => {
    const proc = fakeProcess('win32');

    interruptProcess(proc as never);

    expect(proc.emit).toHaveBeenCalledWith('SIGINT', 'SIGINT');
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it.each(['linux', 'darwin'] as const)('sends a real SIGINT on %s', (platform) => {
    const proc = fakeProcess(platform);

    interruptProcess(proc as never);

    expect(proc.kill).toHaveBeenCalledWith(4242, 'SIGINT');
    expect(proc.emit).not.toHaveBeenCalled();
  });
});

/**
 * Regression test for shortcuts that stopped working after `r`: they were remembered on a field
 * Vite 8 no longer reads (`_shortcutsOptions`), so after `server.restart()` nothing bound them
 * again, and their stdin listener had gone with the old HTTP server.
 */
describe('bindShortcuts after the restart shortcut', () => {
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  let original: { isTTY?: boolean; setRawMode?: unknown; ci?: string };

  beforeEach(() => {
    original = { isTTY: stdin.isTTY, setRawMode: stdin.setRawMode, ci: process.env.CI };
    Object.defineProperty(stdin, 'isTTY', { value: true, configurable: true });
    stdin.setRawMode = vi.fn() as never;
    delete process.env.CI;
    vi.spyOn(stdin, 'resume').mockReturnValue(stdin);
    vi.spyOn(stdin, 'pause').mockReturnValue(stdin);
  });

  afterEach(() => {
    Object.defineProperty(stdin, 'isTTY', { value: original.isTTY, configurable: true });
    stdin.setRawMode = original.setRawMode as never;

    if (original.ci !== undefined) {
      process.env.CI = original.ci;
    }

    vi.restoreAllMocks();
  });

  it('binds the shortcuts again to the restarted server', async () => {
    const custom = vi.fn();
    const server = {
      httpServer: new EventEmitter(),
      // Vite's restart closes the old HTTP server and keeps the same server object.
      restart: vi.fn(async () => {
        server.httpServer.emit('close');
        server.httpServer = new EventEmitter();
      }),
      config: { logger: { info: vi.fn() } },
    };

    bindShortcuts(server as unknown as ViteDevServer, {
      customShortcuts: [{ key: 'x', description: 'custom', action: custom }],
    });

    stdin.emit('data', 'r');
    await vi.waitFor(() => expect(server.restart).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));

    stdin.emit('data', 'x');
    await vi.waitFor(() => expect(custom).toHaveBeenCalledTimes(1));

    // Unbind: the binding detaches when its HTTP server closes.
    server.httpServer.emit('close');
    stdin.emit('data', 'x');
    expect(custom).toHaveBeenCalledTimes(1);
  });
});
