/**
 * Starting a fixture's dev server for the E2E suites, reading its output and cleaning up after it.
 */
import { spawn, execSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';

export interface DevServerProcess {
  proc: ChildProcess;
  /** Every non-empty output line so far, stdout and stderr together. */
  lines: string[];
  /** The first line matching `pattern`, already printed or still to come. Rejects if the process exits first. */
  waitForLine(pattern: RegExp, timeoutMs?: number): Promise<string>;
  /** Settles with the exit code once the process has exited and its output has ended. */
  closed: Promise<number | null>;
  /** Kills the process and everything it started (see {@link killTree}). */
  kill(signal?: NodeJS.Signals): void;
}

/**
 * Kills `proc` with everything it started. On Windows a signal only ends the process it is sent to
 * (`npm.cmd`, not the node and Next.js processes under it), so the tree goes through `taskkill`. On
 * POSIX the process runs in a group of its own (see {@link startDevServer}), signalled as a whole.
 */
export function killTree(proc: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' });
    } catch {
      // Already gone.
    }

    return;
  }

  try {
    process.kill(-proc.pid, signal);
  } catch {
    proc.kill(signal);
  }
}

/**
 * Starts `command` in a process group of its own (POSIX), collecting its output line by line.
 * `echo` copies the output to this process's stdout, to see it in the test log.
 */
export function startDevServer(
  command: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; shell?: boolean; echo?: boolean },
): DevServerProcess {
  const proc = spawn(command, args, {
    cwd: opts.cwd,
    env: { ...process.env, NO_COLOR: '1', ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: opts.shell,
    detached: process.platform !== 'win32',
  });
  const lines: string[] = [];
  const listeners = new Set<(line: string) => void>();
  let pending = '';

  const onData = (data: Buffer) => {
    const text = data.toString();

    if (opts.echo) {
      process.stdout.write(text);
    }

    pending += text;

    const parts = pending.split(/\r?\n/);

    pending = parts.pop() ?? '';

    for (const line of parts.map((part) => part.trim()).filter(Boolean)) {
      lines.push(line);

      for (const listener of [...listeners]) {
        listener(line);
      }
    }
  };

  proc.stdout?.on('data', onData);
  proc.stderr?.on('data', onData);

  const closed = new Promise<number | null>((resolve) => proc.once('close', (code) => resolve(code)));

  return {
    proc,
    lines,
    closed,
    kill: (signal) => killTree(proc, signal),
    waitForLine(pattern, timeoutMs = 30_000) {
      const printed = lines.find((line) => pattern.test(line));

      if (printed) {
        return Promise.resolve(printed);
      }

      return new Promise((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          listeners.delete(onLine);
          proc.off('exit', onExit);
        };
        const onLine = (line: string) => {
          if (pattern.test(line)) {
            done();
            resolve(line);
          }
        };
        const onExit = (code: number | null) => {
          done();
          reject(new Error(`Exited with ${code} before printing ${pattern}:\n${lines.join('\n')}`));
        };
        const timer = setTimeout(() => {
          done();
          reject(new Error(`Timeout (${timeoutMs} ms) waiting for ${pattern}:\n${lines.join('\n')}`));
        }, timeoutMs);

        listeners.add(onLine);
        proc.once('exit', onExit);
      });
    },
  };
}

/**
 * Points the `mi.url` of the fixture config at `url` (mock-mi), so no test depends on the VPN-only
 * MI instance. Returns the original content and a function that writes it back.
 */
export function pointConfigAt(configPath: string, url: string): { original: string; restore(): void } {
  const original = fs.readFileSync(configPath, 'utf-8');
  const patched = original.replace(/url:\s*['"]https?:\/\/[^'"]+['"]/, `url: '${url}'`);

  if (patched === original) {
    throw new Error(`Could not point ${configPath} at ${url}`);
  }

  fs.writeFileSync(configPath, patched);

  return { original, restore: () => fs.writeFileSync(configPath, original) };
}
