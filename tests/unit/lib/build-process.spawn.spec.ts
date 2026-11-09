import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();

  return { ...actual, spawn: spawnMock, spawnSync: spawnSyncMock };
});

const { runBuildProcess, runNextBuildProcess } = await import('../../../src/lib/next-build-runner.js');
const { PP_DEV_NEXT_BUILD_DIST_DIR_ENV_VAR, PP_DEV_NEXT_BUILD_ENV_VAR } = await import('../../../src/constants.js');

/**
 * `pp-dev next-build` runs `next build` from the terminal through the same runner as a sync. Put in
 * a process group of its own, it no longer got Ctrl+C; with the sync's 10-minute limit as the
 * default, a long build was stopped halfway.
 */
describe('runBuildProcess — a build started from the terminal', () => {
  // The fake build's pid is made up: a real `process.kill(-pid)` (POSIX) or `taskkill /PID` (Windows)
  // could hit an unrelated process (group) on the machine running the tests.
  let killMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    killMock = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    vi.restoreAllMocks();
  });

  function fakeBuild() {
    const proc = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null, kill: vi.fn() });

    spawnMock.mockReturnValue(proc);

    return proc;
  }

  it('stays in the terminal’s process group, so Ctrl+C reaches it', async () => {
    const proc = fakeBuild();
    const build = runBuildProcess('next build', 'node', ['build'], { cwd: '.', env: {} as NodeJS.ProcessEnv });

    expect(spawnMock).toHaveBeenCalledWith('node', ['build'], expect.objectContaining({ detached: false }));

    proc.emit('close', 0);
    await expect(build).resolves.toBeUndefined();
  });

  it('has no time limit', async () => {
    vi.useFakeTimers();

    const proc = fakeBuild();
    const build = runBuildProcess('next build', 'node', ['build'], { cwd: '.', env: {} as NodeJS.ProcessEnv });

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(proc.kill).not.toHaveBeenCalled();

    proc.emit('close', 0);
    await expect(build).resolves.toBeUndefined();
  });

  // On a POSIX platform whatever the tests run on, so the group handling is checked on Windows too.
  it('runs a build pp-dev can stop in a process group of its own (POSIX)', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    const proc = fakeBuild();
    const build = runBuildProcess('pp-dev build', 'node', ['build'], {
      cwd: '.',
      env: {} as NodeJS.ProcessEnv,
      signal: new AbortController().signal,
    });

    expect(spawnMock).toHaveBeenCalledWith('node', ['build'], expect.objectContaining({ detached: true }));

    proc.emit('close', 0);
    await expect(build).resolves.toBeUndefined();

    // Its group goes with it, and only its group.
    expect(killMock).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });
});

describe('runBuildProcess — stopping a build on Windows', () => {
  afterEach(() => {
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    vi.restoreAllMocks();
  });

  // `spawnSync('taskkill')` held the dev server's event loop until taskkill returned (over a second).
  it('kills the build tree without blocking: taskkill is spawned, not run synchronously', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const proc = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null, kill: vi.fn() });
    const taskkill = new EventEmitter();

    spawnMock.mockImplementation((command: string) => (command === 'taskkill' ? taskkill : proc));

    const controller = new AbortController();
    const build = runBuildProcess('pp-dev build', 'node', ['build'], {
      cwd: '.',
      env: {} as NodeJS.ProcessEnv,
      signal: controller.signal,
    });

    controller.abort();

    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '4242', '/T', '/F'],
      expect.objectContaining({ stdio: 'ignore' }),
    );
    expect(spawnSyncMock).not.toHaveBeenCalled();

    // A taskkill that fails (not installed, the process gone already) is no error of the build's.
    taskkill.emit('error', new Error('spawn taskkill ENOENT'));
    proc.emit('close', null);

    await expect(build).rejects.toThrow('pp-dev build was stopped');
  });
});

describe('runNextBuildProcess — the distDir of the build', () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.unstubAllEnvs();
  });

  function fakeBuild() {
    const proc = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null, kill: vi.fn() });

    spawnMock.mockReturnValue(proc);

    return proc;
  }

  const buildEnv = () => (spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv }).env;

  // `withPPDev()` reads it in the `next build` process: a template sync's build gets a distDir of
  // its own, apart from the dev server's.
  it('passes the distDir asked for to the build', async () => {
    const proc = fakeBuild();
    const build = runNextBuildProcess(process.cwd(), { distDir: '.next' });

    proc.emit('close', 0);
    await build;

    expect(buildEnv()[PP_DEV_NEXT_BUILD_DIST_DIR_ENV_VAR]).toBe('.next');
    expect(buildEnv()[PP_DEV_NEXT_BUILD_ENV_VAR]).toBe('1');
  });

  it("passes none otherwise, not even one from pp-dev's own environment", async () => {
    vi.stubEnv(PP_DEV_NEXT_BUILD_DIST_DIR_ENV_VAR, 'elsewhere');

    const proc = fakeBuild();
    const build = runNextBuildProcess(process.cwd());

    proc.emit('close', 0);
    await build;

    expect(buildEnv()).not.toHaveProperty(PP_DEV_NEXT_BUILD_DIST_DIR_ENV_VAR);
  });
});
