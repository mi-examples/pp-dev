import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();

  return { ...actual, spawn: spawnMock };
});

const { runBuildProcess } = await import('../../../src/lib/next-build-runner.js');

/**
 * `pp-dev next-build` runs `next build` from the terminal through the same runner as a sync. Put in
 * a process group of its own, it no longer got Ctrl+C; with the sync's 10-minute limit as the
 * default, a long build was stopped halfway.
 */
describe('runBuildProcess — a build started from the terminal', () => {
  afterEach(() => {
    vi.useRealTimers();
    spawnMock.mockReset();
  });

  function fakeBuild() {
    const proc = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null, kill: vi.fn() });

    spawnMock.mockReturnValue(proc);

    return proc;
  }

  it('stays in the terminal’s process group, so Ctrl+C reaches it', async () => {
    const proc = fakeBuild();
    const build = runBuildProcess('next build', 'node', ['build'], { cwd: '.', env: {} });

    expect(spawnMock).toHaveBeenCalledWith('node', ['build'], expect.objectContaining({ detached: false }));

    proc.emit('close', 0);
    await expect(build).resolves.toBeUndefined();
  });

  it('has no time limit', async () => {
    vi.useFakeTimers();

    const proc = fakeBuild();
    const build = runBuildProcess('next build', 'node', ['build'], { cwd: '.', env: {} });

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(proc.kill).not.toHaveBeenCalled();

    proc.emit('close', 0);
    await expect(build).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('runs a build pp-dev can stop in a process group of its own', async () => {
    const proc = fakeBuild();
    const build = runBuildProcess('pp-dev build', 'node', ['build'], {
      cwd: '.',
      env: {},
      signal: new AbortController().signal,
    });

    expect(spawnMock).toHaveBeenCalledWith('node', ['build'], expect.objectContaining({ detached: true }));

    proc.emit('close', 0);
    await expect(build).resolves.toBeUndefined();
  });
});
