import { describe, it, expect, afterEach } from 'vitest';
import { saveDevServerState } from '../../../src/lib/dev-server-state.js';
import { userRegistry } from '../../../src/lib/user-registry.js';
import { originalSession } from '../../../src/lib/original-session.js';
import { onProxyCacheInvalidate, useMiEnvironment, getMiEnvironment } from '../../../src/lib/proxy-cache.middleware.js';

/**
 * PP-4840: a `pp-dev` restart for another MI instance sets the users, the login and the proxy cache
 * up for it before it can still fail. The server that stays gets its own back.
 */
describe('saveDevServerState', () => {
  afterEach(() => {
    userRegistry.clear();
    originalSession.clear();
  });

  it("puts back the old instance's users, default user and renamed hosts, without the new one's", () => {
    userRegistry.useContext('mi instance');
    userRegistry.add({ name: 'alice', kind: 'token', token: 'mi-token' });
    userRegistry.add({ name: 'bob', kind: 'token', token: 'mi-token-2' });
    userRegistry.setDefaultUser('alice');
    userRegistry.replace('bob', { name: 'robert', kind: 'token', token: 'mi-token-2' });

    const restore = saveDevServerState();

    userRegistry.useContext('stg70 instance');
    userRegistry.add({ name: 'target', kind: 'token', token: 'stg70-token' });

    restore();

    expect(userRegistry.context).toBe('mi instance');
    expect(userRegistry.list().map((user) => [user.name, user.token])).toEqual([
      ['alice', 'mi-token'],
      ['robert', 'mi-token-2'],
    ]);
    expect(userRegistry.defaultUser?.name).toBe('alice');
    expect(userRegistry.renamedTo('bob')).toBe('robert');
  });

  it('puts back the login on the main host', () => {
    originalSession.restoreState({
      ...originalSession.saveState(),
      state: 'active',
      session: 'mi-session',
    });

    const restore = saveDevServerState();

    originalSession.clear();
    expect(originalSession.session).toBeUndefined();

    restore();

    expect(originalSession.state).toBe('active');
    expect(originalSession.session).toBe('mi-session');
  });

  it("puts back the proxy cache's environment, dropping what was cached since", () => {
    useMiEnvironment({ name: 'default', url: 'https://mi', appId: 1 });

    const before = getMiEnvironment();
    const restore = saveDevServerState();
    let invalidated = 0;
    const stop = onProxyCacheInvalidate(() => invalidated++);

    useMiEnvironment({ name: 'stg70', url: 'https://stg70', appId: 2 });
    restore();
    stop();

    expect(getMiEnvironment()).toBe(before);
    // Once for the switch, once for coming back: a later switch to stg70 would serve mi's otherwise.
    expect(invalidated).toBe(2);
  });
});
