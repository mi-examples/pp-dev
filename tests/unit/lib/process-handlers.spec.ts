import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { registerProcessHandlers } from '../../../src/lib/process-handlers.js';

/**
 * Regression tests for the dev server's process handlers.
 *
 * `pp-dev next` registered SIGINT/SIGTERM/uncaughtException/unhandledRejection handlers twice, one
 * set of them again on every config-watcher restart, so one Ctrl-C ran two shutdowns at once and
 * enough restarts gave MaxListenersExceededWarning. Both `pp-dev` and `pp-dev next` exited with 0
 * after an uncaught exception, and a single unhandled rejection in any middleware shut the whole
 * dev server down.
 */

function setup({ shutdown = vi.fn().mockResolvedValue(undefined), shutdownTimeoutMs = 5000 } = {}) {
  const proc = Object.assign(new EventEmitter(), { exit: vi.fn() });
  const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
  const dispose = registerProcessHandlers({ logger, shutdown, shutdownTimeoutMs, processRef: proc as never });

  return { proc, logger, shutdown, dispose };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('registerProcessHandlers', () => {
  it('registers one listener per event', () => {
    const { proc } = setup();

    for (const event of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
      expect(proc.listenerCount(event)).toBe(1);
    }
  });

  it.each(['SIGINT', 'SIGTERM'])('shuts down once on %s and exits with 0', async (signal) => {
    const { proc, shutdown } = setup();

    proc.emit(signal);
    await flush();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(0);
  });

  it('exits at once on a second signal while shutting down, without a second shutdown', async () => {
    let finish!: () => void;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { proc } = setup({ shutdown });

    proc.emit('SIGINT');
    proc.emit('SIGINT');

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(0);

    finish();
    await flush();
  });

  it('shuts down and exits with 1 after an uncaught exception', async () => {
    const { proc, shutdown, logger } = setup();

    proc.emit('uncaughtException', new Error('boom'));
    await flush();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Error: boom'));
  });

  it('logs an unhandled rejection and keeps the server running', async () => {
    const { proc, shutdown, logger } = setup();

    proc.emit('unhandledRejection', new Error('middleware failed'), Promise.resolve());
    await flush();

    expect(shutdown).not.toHaveBeenCalled();
    expect(proc.exit).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('middleware failed'));
  });

  it('exits with 1 when the shutdown fails', async () => {
    const { proc } = setup({ shutdown: vi.fn().mockRejectedValue(new Error('close failed')) });

    proc.emit('SIGTERM');
    await flush();

    expect(proc.exit).toHaveBeenCalledWith(1);
  });

  describe('with a shutdown that hangs', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('exits with 1 once the timeout is reached', () => {
      const { proc } = setup({ shutdown: vi.fn(() => new Promise<void>(() => {})), shutdownTimeoutMs: 1000 });

      proc.emit('SIGINT');
      vi.advanceTimersByTime(999);

      expect(proc.exit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);

      expect(proc.exit).toHaveBeenCalledWith(1);
    });
  });

  it('removes its listeners when disposed', () => {
    const { proc, dispose } = setup();

    dispose();

    for (const event of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
      expect(proc.listenerCount(event)).toBe(0);
    }
  });
});
