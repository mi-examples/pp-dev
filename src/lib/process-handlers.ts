import { colors } from './helpers/color.helper.js';

type ProcessLike = Pick<NodeJS.Process, 'on' | 'off'> & { exit: (code?: number) => void };

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
 * - SIGINT / SIGTERM shut down and exit with 0. A second signal while shutting down exits at once.
 * - An uncaught exception leaves the process in an unknown state: shut down and exit with 1, so a
 *   crash never reports success.
 * - An unhandled rejection is logged and the server keeps running, as Vite does: one rejected
 *   promise in a middleware must not take the whole dev server down.
 * - A shutdown that fails, or takes longer than `shutdownTimeoutMs`, exits with 1.
 */
export function registerProcessHandlers({
  logger,
  knownRejections = [],
  shutdown,
  shutdownTimeoutMs = 5000,
  processRef = process,
}: ProcessHandlersOptions): () => void {
  let shuttingDown = false;

  const shutdownAndExit = async (reason: string, exitCode: number) => {
    if (shuttingDown) {
      if (reason === 'SIGINT' || reason === 'SIGTERM') {
        logger.warn(colors.yellow(`\n⚠️  Received ${reason} again, exiting without waiting for the shutdown`));
        processRef.exit(exitCode);
      }

      return;
    }

    shuttingDown = true;
    logger.info(colors.yellow(`\n🛑 Received ${reason}, shutting down gracefully...`));

    const timeout = setTimeout(() => {
      logger.error(colors.red(`⏰ Shutdown did not finish within ${shutdownTimeoutMs} ms, forcing exit`));
      processRef.exit(EXIT_FAILURE);
    }, shutdownTimeoutMs);

    // Never keeps the process alive on its own.
    timeout.unref?.();

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

  processRef.on('SIGINT', onSigint);
  processRef.on('SIGTERM', onSigterm);
  processRef.on('uncaughtException', onUncaughtException);
  processRef.on('unhandledRejection', onUnhandledRejection);

  return () => {
    processRef.off('SIGINT', onSigint);
    processRef.off('SIGTERM', onSigterm);
    processRef.off('uncaughtException', onUncaughtException);
    processRef.off('unhandledRejection', onUnhandledRejection);
  };
}
