import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger } from '../../../src/lib/logger.js';

/**
 * Regression tests for `--logLevel` being ignored: `createLogger(level)` returned the logger the
 * first caller created, whatever level it asked for, and the first caller is usually a module
 * asking for none (`info`).
 */
describe('createLogger', () => {
  afterEach(() => {
    createLogger('info');
    vi.restoreAllMocks();
  });

  it('applies a level given after the logger was first created, to every holder of it', () => {
    // Vite's logger writes info to console.log and warnings to console.warn.
    const infoOutput = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnOutput = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A module took the logger early, before the command applied --logLevel.
    const early = createLogger();

    expect(createLogger('warn')).toBe(early);

    early.info('hidden at warn');
    expect(infoOutput).not.toHaveBeenCalled();

    early.warn('shown at warn');
    expect(warnOutput).toHaveBeenCalledTimes(1);
  });

  it('keeps the level when a later call gives none', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    createLogger('error');
    createLogger().info('still hidden');

    expect(output).not.toHaveBeenCalled();
  });

  it('shares warnings state through the shared object', () => {
    const logger = createLogger('info');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    logger.hasWarned = false;
    logger.warn('a warning');

    expect(logger.hasWarned).toBe(true);
  });
});
