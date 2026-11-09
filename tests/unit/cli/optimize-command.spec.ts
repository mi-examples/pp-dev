import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cac } from 'cac';
import type { ResolvedConfig } from 'vite';

const optimizeDeps = vi.fn(async (_config: ResolvedConfig) => undefined);
const loadCommandViteConfig = vi.fn(async (_options: { mode: string; command: string }) => ({ config: {} }));

vi.mock('vite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vite')>()),
  optimizeDeps: (config: ResolvedConfig) => optimizeDeps(config),
}));

vi.mock('../../../src/cli/vite-config.js', () => ({
  loadCommandViteConfig: (options: { mode: string; command: string }) => loadCommandViteConfig(options),
}));

const { registerOptimizeCommand } = await import('../../../src/cli/commands/optimize.js');

async function runOptimize(...args: string[]): Promise<void> {
  const cli = cac('pp-dev');

  cli.option('-m, --mode <mode>', 'mode');
  registerOptimizeCommand(cli);
  cli.parse(['node', 'pp-dev', 'optimize', ...args], { run: false });
  await cli.runMatchedCommand();
}

/**
 * `pp-dev optimize` loaded the config file and the pp-dev env for `production` but resolved the
 * config with Vite's `serve` default, `development`: the optimizer ran development hooks over a
 * config function evaluated for production. Vite's own `optimize` uses one mode for both.
 */
describe('pp-dev optimize', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-optimize-'));
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    optimizeDeps.mockClear();
    loadCommandViteConfig.mockClear();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('loads the config and runs the optimizer in one mode, development without --mode, as Vite does', async () => {
    await runOptimize(root);

    expect(loadCommandViteConfig).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'development', command: 'serve' }),
    );
    expect(optimizeDeps).toHaveBeenCalledTimes(1);
    expect(optimizeDeps.mock.calls[0][0].mode).toBe('development');
  });

  it('uses the --mode it is given for both', async () => {
    await runOptimize(root, '--mode', 'staging');

    expect(loadCommandViteConfig).toHaveBeenCalledWith(expect.objectContaining({ mode: 'staging' }));
    expect(optimizeDeps.mock.calls[0][0].mode).toBe('staging');
  });
});
