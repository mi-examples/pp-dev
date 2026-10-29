import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runBuildProcess } from '../../../src/lib/next-build-runner.js';

/**
 * The builds a template sync starts (`pp-dev build`, `next build`) had no time limit and were not
 * stopped with the dev server: a hung one kept that sync, and every later one, waiting, and outlived
 * the dev server it was started from.
 */

const HANG = ['-e', 'setInterval(() => {}, 1000)'];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

/** The pid a child wrote to `pidFile`, once it has. */
async function waitForPid(pidFile: string): Promise<number> {
  const deadline = Date.now() + 10_000;

  while (!fs.existsSync(pidFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return Number(fs.readFileSync(pidFile, 'utf8'));
}

describe('runBuildProcess', () => {
  it('resolves when the build exits with 0', async () => {
    await expect(
      runBuildProcess('test build', process.execPath, ['-e', 'process.exit(0)'], {
        cwd: process.cwd(),
        env: process.env,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects with the exit code of a failed build', async () => {
    await expect(
      runBuildProcess('test build', process.execPath, ['-e', 'process.exit(3)'], {
        cwd: process.cwd(),
        env: process.env,
      }),
    ).rejects.toThrow('test build exited with code 3');
  });

  it('stops a build that runs past its time limit', async () => {
    const started = Date.now();

    await expect(
      runBuildProcess('test build', process.execPath, HANG, { cwd: process.cwd(), env: process.env, timeoutMs: 300 }),
    ).rejects.toThrow('test build timed out');

    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('stops a build when its signal aborts, killing the process', async () => {
    const controller = new AbortController();
    // The child's pid, which runBuildProcess doesn't expose, to check it is gone afterwards.
    const pidFile = path.join(os.tmpdir(), `pp-dev-build-process-${process.pid}-${Date.now()}.pid`);
    const promise = runBuildProcess(
      'test build',
      process.execPath,
      [
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ],
      { cwd: process.cwd(), env: process.env, signal: controller.signal },
    );

    try {
      const deadline = Date.now() + 10_000;

      while (!fs.existsSync(pidFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const pid = Number(fs.readFileSync(pidFile, 'utf8'));

      expect(isAlive(pid)).toBe(true);

      controller.abort();

      await expect(promise).rejects.toThrow('test build was stopped');
      expect(isAlive(pid)).toBe(false);
    } finally {
      fs.rmSync(pidFile, { force: true });
    }
  });

  // The group was ended only for a stopped build: a worker of one that failed kept running, out of
  // reach of a later stop and of Ctrl+C. (On Windows the tree is gone once the build exits.)
  it.skipIf(process.platform === 'win32')('ends what a failed build left running', async () => {
    const pidFile = path.join(os.tmpdir(), `pp-dev-build-failed-${process.pid}-${Date.now()}.pid`);
    const worker = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const promise = runBuildProcess(
      'test build',
      process.execPath,
      [
        '-e',
        `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: 'ignore' });` +
          ` const wait = () => require('fs').existsSync(${JSON.stringify(pidFile)}) ? process.exit(1) : setTimeout(wait, 20); wait();`,
      ],
      { cwd: process.cwd(), env: process.env, signal: new AbortController().signal },
    );

    try {
      await expect(promise).rejects.toThrow('test build exited with code 1');

      const pid = Number(fs.readFileSync(pidFile, 'utf8'));

      await expect.poll(() => isAlive(pid), { timeout: 3_000 }).toBe(false);
    } finally {
      fs.rmSync(pidFile, { force: true });
    }
  });

  // `next build` runs workers. Stopping only the process we spawned left them running (on POSIX,
  // SIGTERM went to that one process), still writing the build output.
  it('stops the processes the build started, too', async () => {
    const controller = new AbortController();
    const pidFile = path.join(os.tmpdir(), `pp-dev-build-worker-${process.pid}-${Date.now()}.pid`);
    const worker = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const promise = runBuildProcess(
      'test build',
      process.execPath,
      [
        '-e',
        `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`,
      ],
      { cwd: process.cwd(), env: process.env, signal: controller.signal },
    );

    try {
      const pid = await waitForPid(pidFile);

      expect(isAlive(pid)).toBe(true);

      controller.abort();

      await expect(promise).rejects.toThrow('test build was stopped');
      await expect.poll(() => isAlive(pid), { timeout: 5_000 }).toBe(false);
    } finally {
      fs.rmSync(pidFile, { force: true });
    }
  });

  // A build that ignores SIGTERM kept the sync waiting for it forever. (On Windows, `taskkill /F`
  // already stops it outright.)
  it.skipIf(process.platform === 'win32')(
    'kills a build that timed out and ignores SIGTERM after the grace period',
    async () => {
      const started = Date.now();
      const promise = runBuildProcess(
        'test build',
        process.execPath,
        ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        { cwd: process.cwd(), env: process.env, timeoutMs: 300, killGraceMs: 300 },
      );

      await expect(promise).rejects.toThrow('test build timed out');
      expect(Date.now() - started).toBeLessThan(5_000);
    },
  );

  // `dispose()` doesn't wait, and the dev server exits right after: a SIGKILL still due after a grace
  // period never came, leaving a build that ignores SIGTERM running.
  it('kills a build stopped with the dev server at once, without a grace period', async () => {
    const controller = new AbortController();
    const pidFile = path.join(os.tmpdir(), `pp-dev-build-stubborn-${process.pid}-${Date.now()}.pid`);
    const promise = runBuildProcess(
      'test build',
      process.execPath,
      [
        '-e',
        `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ],
      { cwd: process.cwd(), env: process.env, signal: controller.signal, killGraceMs: 60_000 },
    );

    try {
      const pid = await waitForPid(pidFile);

      controller.abort();

      // Handled right away: the rejection may come before the process is seen gone.
      const stopped = expect(promise).rejects.toThrow('test build was stopped');

      // Sent before `abort()` returns, so it holds even if the process exits right after.
      await expect.poll(() => isAlive(pid), { timeout: 3_000 }).toBe(false);
      await stopped;
    } finally {
      fs.rmSync(pidFile, { force: true });
    }
  });

  // Stopping with the dev server did nothing to a build already in its timeout's grace period: one
  // ignoring SIGTERM outlived the server if it exited before the grace timer fired.
  it('kills a build in its timeout grace period at once when the dev server stops', async () => {
    const controller = new AbortController();
    const pidFile = path.join(os.tmpdir(), `pp-dev-build-grace-${process.pid}-${Date.now()}.pid`);
    const promise = runBuildProcess(
      'test build',
      process.execPath,
      [
        '-e',
        `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ],
      { cwd: process.cwd(), env: process.env, signal: controller.signal, timeoutMs: 200, killGraceMs: 60_000 },
    );
    const timedOut = expect(promise).rejects.toThrow('test build timed out');

    try {
      const pid = await waitForPid(pidFile);

      // Past the timeout, inside its grace period.
      await new Promise((resolve) => setTimeout(resolve, 500));
      controller.abort();

      await expect.poll(() => isAlive(pid), { timeout: 3_000 }).toBe(false);
      await timedOut;
    } finally {
      fs.rmSync(pidFile, { force: true });
    }
  });

  it('does not start a build whose signal already aborted', async () => {
    const controller = new AbortController();

    controller.abort();

    await expect(
      runBuildProcess('test build', process.execPath, HANG, {
        cwd: process.cwd(),
        env: process.env,
        signal: controller.signal,
      }),
    ).rejects.toThrow('test build was stopped');
  });
});
