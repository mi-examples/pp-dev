import { describe, it, expect, vi, afterEach } from 'vitest';
import { AuthProvider } from '../../../src/lib/auth.provider.js';
import { createLogger } from '../../../src/lib/logger.js';

/** A failing state listener was reported with `console.error`, past pp-dev's logger (level, format). */
describe('AuthProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a failing listener through pp-dev's logger, and still notifies the others", () => {
    const provider = new AuthProvider();
    const error = vi.spyOn(createLogger(), 'error').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const other = vi.fn();

    provider.subscribe(() => {
      throw new Error('listener failed');
    });
    provider.subscribe(other);
    provider.setRedirected(true);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('listener failed'));
    expect(consoleError).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledWith(expect.objectContaining({ isRedirected: true }));
  });
});
