import { createLogger as createViteLogger, Logger, LogLevel } from 'vite';

const DEFAULT_LEVEL: LogLevel = 'info';

let current: { level: LogLevel; logger: Logger } | undefined;
let shared: Logger | undefined;

function active(): Logger {
  current ??= { level: DEFAULT_LEVEL, logger: createViteLogger(DEFAULT_LEVEL) };

  return current.logger;
}

/**
 * pp-dev's logger: one object shared by every module.
 *
 * Modules keep the logger they got, often from a call made before the command applies
 * `--logLevel`, so the level can't be fixed when the object is created (it used to be: the first
 * caller's level, usually the default, won and `--logLevel` was ignored). The shared object
 * forwards to a Vite logger that a call with a level replaces; calls without one keep it.
 */
export function createLogger(level?: LogLevel): Logger {
  if (level !== undefined && level !== current?.level) {
    current = { level, logger: createViteLogger(level) };
  }

  shared ??= {
    info: (msg, options) => active().info(msg, options),
    warn: (msg, options) => active().warn(msg, options),
    warnOnce: (msg, options) => active().warnOnce(msg, options),
    error: (msg, options) => active().error(msg, options),
    clearScreen: (type) => active().clearScreen(type),
    hasErrorLogged: (error) => active().hasErrorLogged(error),
    get hasWarned() {
      return active().hasWarned;
    },
    set hasWarned(value) {
      active().hasWarned = value;
    },
  };

  return shared;
}
