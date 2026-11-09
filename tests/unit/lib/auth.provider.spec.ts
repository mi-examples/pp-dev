import { describe, it, expect, expectTypeOf, vi, afterEach } from 'vitest';
import { AuthProvider, type AuthState } from '../../../src/lib/auth.provider.js';
import { createLogger } from '../../../src/lib/logger.js';

/**
 * `AuthState` and `AuthProvider` are exported by the package, and 1.4.7's state had `lastChecked`,
 * the time of the last authentication update: dropping it broke consumers that read it.
 */
describe('AuthProvider lastChecked', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is part of the exported state type', () => {
    expectTypeOf<AuthState>().toHaveProperty('lastChecked').toEqualTypeOf<number>();
  });

  it('starts at 0, is stamped by setAuthenticated and updateState, and goes back to 0 on reset', () => {
    const provider = new AuthProvider();

    expect(provider.getState().lastChecked).toBe(0);

    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-06T10:00:00.000Z') });
    provider.setAuthenticated(true);
    expect(provider.getState().lastChecked).toBe(Date.parse('2026-11-06T10:00:00.000Z'));

    vi.setSystemTime(new Date('2026-11-06T10:05:00.000Z'));
    provider.updateState({ isRedirected: true });
    expect(provider.getState().lastChecked).toBe(Date.parse('2026-11-06T10:05:00.000Z'));

    provider.reset();
    expect(provider.getState().lastChecked).toBe(0);
  });
});

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
