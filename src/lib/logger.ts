import { createLogger as cL, Logger, LogLevel } from 'vite';

let storage: Map<string, Logger> | undefined = new Map<string, Logger>();

export const DEFAULT_LOGGER_KEY = 'default';

export const createLogger = (level: LogLevel = 'info', name = DEFAULT_LOGGER_KEY): Logger => {
  // Safety check: ensure storage is initialized (handles edge cases in CJS)
  if (!storage || typeof storage.has !== 'function') {
    storage = new Map<string, Logger>();
  }
  
  if (storage.has(name)) {
    return storage.get(name) as unknown as Logger;
  }

  if (name === DEFAULT_LOGGER_KEY) {
    const logger = cL(level);

    storage.set(name, logger);

    return logger;
  }

  const logger = cL(level);

  storage.set(name, logger);

  return logger;
};
