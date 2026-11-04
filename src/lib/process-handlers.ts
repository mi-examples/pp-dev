import { colors } from './helpers/color.helper.js';

type ProcessLike = Pick<NodeJS.Process, 'on' | 'off'> & { exit: (code?: number) => void; send?: unknown };

/** From the server process to `pp-dev next`'s supervisor: the server is listening. */
export const SUPERVISOR_READY_MESSAGE = 'pp-dev:ready';
/** From the supervisor to the server process: shut down (a signal it received, or a config change). */
export const SUPERVISOR_SHUTDOWN_MESSAGE = 'pp-dev:shutdown';

export type SupervisorMessage =
  { type: typeof SUPERVISOR_READY_MESSAGE } | { type: typeof SUPERVISOR_SHUTDOWN_MESSAGE; reason: string };

function isShutdownMessage(message: unknown): message is Extract<SupervisorMessage, { reason: string }> {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === SUPERVISOR_SHUTDOWN_MESSAGE &&
    typeof (message as { reason?: unknown }).reason === 'string'
  );
}

interface ProcessHandlersLogger {
  info: (message: string) => void;
  error: (message: string) => void;
  warn: (message: string) => void;
}

/** An unhandled rejection that is known to be harmless: logged as one short line, without a stack. */
export interface KnownRejection {
  matches: (reason: unknown) => boolean;
  message: string;
}

export interface ProcessHandlersOptions {
  logger: ProcessHandlersLogger;
  knownRejections?: KnownRejection[];
  /** Closes what the command opened. Runs at most once; the process exits after it. */
  shutdown: () => Promise<void>;
  /** How long `shutdown` may take before the process exits anyway. @default 5000 */
  shutdownTimeoutMs?: number;
  /** For tests. @default process */
  processRef?: ProcessLike;
}

/** Exit code after a crash or a failed shutdown. */
export const EXIT_FAILURE = 1;

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/**
 * Registers the dev server's process handlers, once per command run (never per server restart),
 * and returns a function that removes them.
 *
 * - SIGINT / SIGTERM / SIGHUP shut down and exit with 0. A second signal while shutting down exits at
 *   once. SIGHUP comes when the terminal closes (on Windows, the console window): by default it would
 *   end the process without the shutdown, leaving a sync's build (in a process group of its own)
 *   writing the output.
 * - An uncaught exception leaves the process in an unknown state: shut down and exit with 1, so a
 *   crash never reports success.
 * - An unhandled rejection is logged and the server keeps running, as Vite does: one rejected
 *   promise in a middleware must not take the whole dev server down.
 * - A shutdown that fails, or takes longer than `shutdownTimeoutMs`, exits with 1.
 * - A process with an IPC channel (the server process of `pp-dev next`) also shuts down on its
 *   supervisor's shutdown message and when the supervisor goes away (the channel disconnects). The
 *   message may repeat a signal the terminal delivered to both processes, in either order: neither
 *   counts as the second signal that exits at once; the next signal after both does.
 */
export function registerProcessHandlers({
  logger,
  knownRejections = [],
  shutdown,
  shutdownTimeoutMs = 5000,
  processRef = process,
}: ProcessHandlersOptions): () => void {
  let shuttingDown = false;
  // The running shutdown was started by the supervisor's message (or its going away), and no
  // signal has been delivered directly yet: the first one is the terminal's, which the message
  // repeated, not a second signal.
  let signalDue = false;
  // The code the process exits with. Only ever escalates: a crash during a signal's shutdown, or a
  // failed shutdown, must not end in 0.
  let exitCode = 0;

  const escalate = (code: number) => {
    exitCode = Math.max(exitCode, code);
  };

  const isSignal = (reason: string) => reason === 'SIGINT' || reason === 'SIGTERM' || reason === 'SIGHUP';

  const shutdownAndExit = async (reason: string, code: number, { repeatable = true } = {}) => {
    escalate(code);

    if (shuttingDown) {
      if (repeatable && isSignal(reason)) {
        if (signalDue) {
          signalDue = false;

          return;
        }

        logger.warn(
          colors.yellow(`
⚠️  Received ${reason} again, exiting without waiting for the shutdown`),
        );
        processRef.exit(exitCode);
      }

      // A crash while shutting down is logged by its handler; the running shutdown exits with 1.
      return;
    }

    shuttingDown = true;
    signalDue = !repeatable;
    logger.info(
      colors.yellow(`
🛑 Received ${reason}, shutting down gracefully...`),
    );

    // Referenced on purpose: should the shutdown close the last handle and then hang, an unref'd
    // timer would let Node exit on its own, with 0, instead of reporting the failure.
    const timeout = setTimeout(() => {
      logger.error(colors.red(`⏰ Shutdown did not finish within ${shutdownTimeoutMs} ms, forcing exit`));
      processRef.exit(EXIT_FAILURE);
    }, shutdownTimeoutMs);

    try {
      await shutdown();
      clearTimeout(timeout);
      logger.info(colors.green('✅ Graceful shutdown completed'));
      processRef.exit(exitCode);
    } catch (error) {
      clearTimeout(timeout);
      logger.error(colors.red(`❌ Error during graceful shutdown: ${describe(error)}`));
      processRef.exit(EXIT_FAILURE);
    }
  };

  const onSigint = () => void shutdownAndExit('SIGINT', 0);
  const onSigterm = () => void shutdownAndExit('SIGTERM', 0);
  const onSighup = () => void shutdownAndExit('SIGHUP', 0);
  const onUncaughtException = (error: unknown) => {
    logger.error(colors.red(`❌ Uncaught exception: ${describe(error)}`));
    void shutdownAndExit('uncaughtException', EXIT_FAILURE);
  };
  const onUnhandledRejection = (reason: unknown) => {
    const known = knownRejections.find((rejection) => rejection.matches(reason));

    if (known) {
      logger.info(colors.dim(known.message));

      return;
    }

    logger.error(colors.red(`❌ Unhandled promise rejection (the server keeps running): ${describe(reason)}`));
  };

  const onMessage = (message: unknown) => {
    if (isShutdownMessage(message)) {
      void shutdownAndExit(message.reason, 0, { repeatable: false });
    }
  };
  const onDisconnect = () => void shutdownAndExit('the end of the pp-dev process', 0, { repeatable: false });
  const supervised = typeof processRef.send === 'function';

  processRef.on('SIGINT', onSigint);
  processRef.on('SIGTERM', onSigterm);
  processRef.on('SIGHUP', onSighup);
  processRef.on('uncaughtException', onUncaughtException);
  processRef.on('unhandledRejection', onUnhandledRejection);

  if (supervised) {
    processRef.on('message', onMessage);
    processRef.on('disconnect', onDisconnect);
  }

  return () => {
    processRef.off('SIGINT', onSigint);
    processRef.off('SIGTERM', onSigterm);
    processRef.off('SIGHUP', onSighup);
    processRef.off('uncaughtException', onUncaughtException);
    processRef.off('unhandledRejection', onUnhandledRejection);

    if (supervised) {
      processRef.off('message', onMessage);
      processRef.off('disconnect', onDisconnect);
    }
  };
}
