import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';
import * as process from 'process';
import { createRequire } from 'module';
import { PP_DEV_NEXT_BUILD_ENV_VAR } from '../constants.js';

/**
 * Remove dev-server route types that `next build` would otherwise type-check as a duplicate.
 *
 * tsconfig includes both `<distDir>/types` and `<distDir>/dev/types`, and `next build` drops the
 * dev ones from the program — but it looks for them under the *build* distDir. With
 * `output: 'export'` and a custom `distDir` (our Next templates use `distDir: 'dist'`), Next builds
 * into `.next` and only exports into `dist`, so it filters `.next/dev/types` while `next dev` wrote
 * `dist/dev/types`. Both copies of the global `validator.ts` then end up in one program and the
 * build fails with "Duplicate identifier 'PagesPageConfig'" after any dev session.
 *
 * Only generated files are removed; the dev server regenerates them on its next start.
 *
 * @returns the removed directory, or null when nothing needed removing
 */
export function removeStaleDevTypes(
  projectRoot: string,
  nextConfig: { output?: string; distDir?: string } | undefined,
): string | null {
  const distDir = nextConfig?.distDir;

  // Same condition as Next's hasCustomExportOutput(): only then do the build and dev dirs diverge.
  if (nextConfig?.output !== 'export' || !distDir || distDir === '.next') {
    return null;
  }

  const devTypesDir = path.resolve(projectRoot, distDir, 'dev', 'types');

  if (!fs.existsSync(devTypesDir)) {
    return null;
  }

  fs.rmSync(devTypesDir, { recursive: true, force: true });

  return devTypesDir;
}

/** How long a sync's build may run before it is stopped. */
export const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60 * 1000;

export interface BuildProcessOptions {
  /** Stops a build that runs longer. None by default: a build started from the terminal runs as long as it takes. */
  timeoutMs?: number;
  /**
   * Stops the build at once, e.g. when the dev server shuts down: it is killed, since the server may
   * exit right after and leave nothing to finish the job.
   */
  signal?: AbortSignal;
  /** How long a build that timed out gets to exit on SIGTERM. @default KILL_GRACE_MS */
  killGraceMs?: number;
}

/** How long a build that timed out gets to exit on SIGTERM before its processes are killed outright. */
const KILL_GRACE_MS = 5_000;

/**
 * Signals a build and everything it started. In its own POSIX process group, the whole group (the
 * workers too: `next build` has several); on Windows `taskkill /T` walks the process tree, and only
 * kills; otherwise the process itself.
 */
function signalBuild(proc: child_process.ChildProcess, signal: 'SIGTERM' | 'SIGKILL', ownGroup: boolean): void {
  if (!proc.pid) {
    return;
  }

  if (process.platform === 'win32') {
    if (proc.exitCode === null && proc.signalCode === null) {
      child_process.spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    }

    return;
  }

  try {
    if (ownGroup) {
      process.kill(-proc.pid, signal);
    } else {
      proc.kill(signal);
    }
  } catch {
    // It has exited already.
  }
}

/**
 * Runs a build command for a template sync, with its output in the dev server's terminal.
 *
 * It is stopped once it runs longer than {@link BuildProcessOptions.timeoutMs} or when
 * {@link BuildProcessOptions.signal} aborts: a hung build used to keep the sync (and every later
 * one) waiting, and outlived the dev server it was started from.
 */
export function runBuildProcess(
  label: string,
  command: string,
  args: string[],
  {
    cwd,
    env,
    timeoutMs,
    signal,
    killGraceMs = KILL_GRACE_MS,
  }: BuildProcessOptions & { cwd: string; env: NodeJS.ProcessEnv },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`${label} was stopped`));

      return;
    }

    // Only a build pp-dev may stop runs in a process group of its own (POSIX), so stopping it reaches
    // the workers it started. One started from the terminal (`pp-dev next-build`) stays in the
    // terminal's group: Ctrl+C has to reach it, which it wouldn't in a group of its own.
    const ownGroup = process.platform !== 'win32' && (signal !== undefined || timeoutMs !== undefined);
    const proc = child_process.spawn(command, args, { cwd, env, stdio: 'inherit', detached: ownGroup });
    let stopReason: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const stop = (reason: string, graceful: boolean) => {
      // A build that timed out is in its grace period: a stop with the dev server still kills it at
      // once (the timer that was to do it may not outlive the server). Anything else is already done.
      if (stopReason) {
        if (!graceful && killTimer !== undefined) {
          clearTimeout(killTimer);
          killTimer = undefined;
          signalBuild(proc, 'SIGKILL', ownGroup);
        }

        return;
      }

      stopReason = reason;

      // A build that timed out gets SIGTERM first, and is killed after the grace period if it is
      // still running (it may ignore SIGTERM). One stopped with the dev server is killed at once:
      // the server may exit right after, and with it any timer that was to kill it later.
      if (graceful) {
        signalBuild(proc, 'SIGTERM', ownGroup);
        killTimer = setTimeout(() => {
          killTimer = undefined;
          signalBuild(proc, 'SIGKILL', ownGroup);
        }, killGraceMs);
      } else {
        signalBuild(proc, 'SIGKILL', ownGroup);
      }
    };
    const onAbort = () => stop(`${label} was stopped`, false);
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => stop(`${label} timed out after ${Math.round(timeoutMs / 1000)} s`, true), timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });

    const settle = (error?: Error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);

      // A stopped build's workers may outlive its main process: none may keep writing the output.
      if (stopReason && ownGroup) {
        signalBuild(proc, 'SIGKILL', ownGroup);
      }

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    proc.on('close', (code) => {
      if (stopReason) {
        settle(new Error(stopReason));
      } else if (code !== 0) {
        settle(new Error(`${label} exited with code ${code}`));
      } else {
        settle();
      }
    });

    proc.on('error', (error) => settle(error));
  });
}

/** Run `next build` in `projectRoot`, resolving the `next` binary from the app itself. */
export async function runNextBuildProcess(projectRoot: string, options: BuildProcessOptions = {}): Promise<void> {
  let nextBin: string;

  try {
    const require = createRequire(path.join(projectRoot, 'package.json'));
    const nextPkgPath = require.resolve('next/package.json');

    nextBin = path.resolve(path.dirname(nextPkgPath), 'dist/bin/next');
  } catch {
    throw new Error(`Unable to resolve the "next" binary from ${projectRoot}. Is Next.js installed?`);
  }

  await runBuildProcess('next build', process.execPath, [nextBin, 'build'], {
    ...options,
    cwd: projectRoot,
    env: Object.assign({}, process.env, { NODE_ENV: 'production', [PP_DEV_NEXT_BUILD_ENV_VAR]: '1' }),
  });
}
