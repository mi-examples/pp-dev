import { createLogger as cL, Logger, LogLevel } from 'vite';

const storage = new Map<string, Logger>();

export const DEFAULT_LOGGER_KEY = 'default';

export const createLogger = (level: LogLevel = 'info', name = DEFAULT_LOGGER_KEY): Logger => {
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
