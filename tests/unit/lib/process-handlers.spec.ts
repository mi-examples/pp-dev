import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { registerProcessHandlers } from '../../../src/lib/process-handlers.js';
import { NEXT_WORKER_SCHEDULER_REJECTION, createNextAppListenerTracker } from '../../../src/lib/next-process-listeners.js';

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

    for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection']) {
      expect(proc.listenerCount(event)).toBe(1);
    }
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'])('shuts down once on %s and exits with 0', async (signal) => {
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

  it('logs a known harmless rejection as one short line, without a stack', async () => {
    const proc = Object.assign(new EventEmitter(), { exit: vi.fn() });
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const shutdown = vi.fn();

    registerProcessHandlers({
      logger,
      shutdown,
      knownRejections: [NEXT_WORKER_SCHEDULER_REJECTION],
      processRef: proc as never,
    });

    proc.emit('unhandledRejection', new Error('Worker creator already registered'), Promise.resolve());
    proc.emit('unhandledRejection', new Error('Worker creator registered twice?'), Promise.resolve());

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('kept its Turbopack worker pool'));
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('    at '));
    // Anything else is still reported in full.
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Worker creator registered twice?'));
    expect(shutdown).not.toHaveBeenCalled();
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it('exits with 1 when an uncaught exception happens during a signal shutdown', async () => {
    let finish!: () => void;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { proc } = setup({ shutdown });

    proc.emit('SIGINT');
    proc.emit('uncaughtException', new Error('crash while closing'));
    finish();
    await flush();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(1);
  });

  it('exits with 1 at once on a signal during a crash shutdown', () => {
    const shutdown = vi.fn(() => new Promise<void>(() => {}));
    const { proc } = setup({ shutdown });

    proc.emit('uncaughtException', new Error('boom'));
    proc.emit('SIGINT');

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(1);
  });

  it('keeps the shutdown watchdog referenced, so a hanging shutdown cannot end the process with 0', async () => {
    const timers: NodeJS.Timeout[] = [];
    const realSetTimeout = globalThis.setTimeout;

    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      const timer = realSetTimeout(...args);

      timers.push(timer);

      return timer;
    }) as typeof setTimeout);

    let finish!: () => void;
    const { proc } = setup({ shutdown: vi.fn(() => new Promise<void>((resolve) => (finish = resolve))) });

    proc.emit('SIGTERM');

    expect(timers).toHaveLength(1);
    expect(timers[0]!.hasRef()).toBe(true);

    finish();
    await flush();

    expect(proc.exit).toHaveBeenCalledWith(0);
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

    for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection']) {
      expect(proc.listenerCount(event)).toBe(0);
    }
  });
});

/**
 * Creating a Next.js dev app adds `uncaughtException` listeners that `close()` leaves attached, so
 * every `pp-dev next` config restart added more (4 → 9 over five restarts). Some of them are added
 * once per process, though, and Next.js never adds those again: they must survive.
 */
describe('createNextAppListenerTracker', () => {
  // A stand-in for a Next.js app: a listener per instance, plus one added once per process.
  function makeNextLike(proc: EventEmitter) {
    let processLevelAdded = false;

    return () => {
      const app = { id: Math.random() };

      proc.on('uncaughtException', (error: unknown) => {
        void app;
        void error;
      });

      if (!processLevelAdded) {
        processLevelAdded = true;
        proc.on('uncaughtException', function logOnce() {});
      }
    };
  }

  it('keeps one listener per app and the once-per-process ones over repeated restarts', () => {
    const proc = new EventEmitter();
    const own = vi.fn();
    const createApp = makeNextLike(proc);
    const tracker = createNextAppListenerTracker(['uncaughtException'], proc as never);

    proc.on('uncaughtException', own);

    for (let start = 0; start < 6; start += 1) {
      tracker.beforeCreate();
      createApp();
      tracker.afterCreate();
    }

    const listeners = proc.listeners('uncaughtException');

    // Ours, Next's once-per-process one, and the current app's.
    expect(listeners).toHaveLength(3);
    expect(listeners[0]).toBe(own);
    expect(listeners.some((listener) => listener.name === 'logOnce')).toBe(true);
  });

  it("removes nothing on the first app, and only the previous app's repeated listeners later", () => {
    const proc = new EventEmitter();
    const createApp = makeNextLike(proc);
    const tracker = createNextAppListenerTracker(['uncaughtException'], proc as never);

    tracker.beforeCreate();
    createApp();

    expect(tracker.afterCreate()).toBe(0);

    tracker.beforeCreate();
    createApp();

    expect(tracker.afterCreate()).toBe(1);
  });

  it('leaves other events alone', () => {
    const proc = new EventEmitter();
    const tracker = createNextAppListenerTracker(['uncaughtException'], proc as never);

    for (let start = 0; start < 3; start += 1) {
      tracker.beforeCreate();
      proc.on('SIGINT', () => {});
      tracker.afterCreate();
    }

    expect(proc.listenerCount('SIGINT')).toBe(3);
  });
});
