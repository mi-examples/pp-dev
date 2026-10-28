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
  /** @default DEFAULT_BUILD_TIMEOUT_MS */
  timeoutMs?: number;
  /** Stops the build, e.g. when the dev server shuts down. */
  signal?: AbortSignal;
  /** How long a stopped build gets to exit on SIGTERM. @default KILL_GRACE_MS */
  killGraceMs?: number;
}

/** How long a stopped build gets to exit on SIGTERM before its processes are killed outright. */
const KILL_GRACE_MS = 5_000;

/**
 * On POSIX a build runs in a process group of its own, so stopping it reaches the workers it
 * started too (`next build` has several), not only the process we spawned. On Windows `taskkill /T`
 * walks the process tree instead, and a detached child would get a console window of its own.
 */
const OWN_PROCESS_GROUP = process.platform !== 'win32';

/** Signals a build and everything it started. */
function signalBuild(proc: child_process.ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (!proc.pid) {
    return;
  }

  if (!OWN_PROCESS_GROUP) {
    if (proc.exitCode === null && proc.signalCode === null) {
      child_process.spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    }

    return;
  }

  try {
    process.kill(-proc.pid, signal);
  } catch {
    // The whole group has exited.
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
    timeoutMs = DEFAULT_BUILD_TIMEOUT_MS,
    signal,
    killGraceMs = KILL_GRACE_MS,
  }: BuildProcessOptions & { cwd: string; env: NodeJS.ProcessEnv },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`${label} was stopped`));

      return;
    }

    const proc = child_process.spawn(command, args, { cwd, env, stdio: 'inherit', detached: OWN_PROCESS_GROUP });
    let stopReason: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    // SIGTERM first; whatever is still running after the grace period (a build that ignores it) is
    // killed, so the sync can't stay waiting for it.
    const stop = (reason: string) => {
      if (stopReason) {
        return;
      }

      stopReason = reason;
      signalBuild(proc, 'SIGTERM');
      killTimer = setTimeout(() => signalBuild(proc, 'SIGKILL'), killGraceMs);
    };
    const onAbort = () => stop(`${label} was stopped`);
    const timer = setTimeout(() => stop(`${label} timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });

    const settle = (error?: Error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);

      // A stopped build's workers may outlive its main process: none may keep writing the output.
      if (stopReason) {
        signalBuild(proc, 'SIGKILL');
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
