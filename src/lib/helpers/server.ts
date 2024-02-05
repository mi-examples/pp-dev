import * as express from 'express';
import * as winston from 'winston';
import * as memoryCache from 'memory-cache';
import type { CacheItem } from '../proxy-cache.middleware.js';
import type { Express } from 'express';
import { URL } from 'url';
import { colors } from './color.helper.js';

declare module 'express' {
  interface Express {
    cache?: memoryCache.CacheClass<string, CacheItem>;
    config: {
      logger: winston.Logger;
    };
    printUrls: (base?: string) => void;
  }
}

export function createDevServer(logLevel = 'info') {
  const server = (express as any).default() as Express;

  const logger = winston.createLogger({
    level: logLevel,
    format: winston.format.cli({ level: true }),
    transports: [new winston.transports.Console()],
  });

  server.config = {
    logger,
  };

  const originalListen = server.listen;

  let listener: ReturnType<express.Express['listen']>;

  server.listen = function (this: express.Express, ...args: Parameters<express.Express['listen']>) {
    listener = originalListen.apply(this, args);
  } as typeof server.listen;

  server.printUrls = function (base?: string) {
    if (!listener) {
      throw new Error('Server is not listening');
    }

    const colorUrl = (url: string) => colors.cyan(url.replace(/:(\d+)\//, (_, port) => `:${colors.bold(port)}/`));

    const address = listener.address();

    if (address && typeof address === 'object') {
      if (address.address === '::') {
        const url = new URL(base || '', `http://localhost:${address.port}`);

        logger.info(`  ${colors.green('➜')}  ${colors.bold('Local')}:   ${colorUrl(url.toString())}`);
      } else {
        const url = new URL(base || '', `http://[${address.address}]:${address.port}`);

        logger.info(`  ${colors.green('➜')}  ${colors.bold('Local')}:   ${colorUrl(url.toString())}`);
      }
    }
  };

  return server;
}
