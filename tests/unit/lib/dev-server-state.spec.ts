import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import type { MiAPI } from '../../../src/lib/pp.middleware.js';
import { saveDevServerState } from '../../../src/lib/dev-server-state.js';
import { startKeepingUsers } from '../../../src/lib/user-store.js';
import { userRegistry } from '../../../src/lib/user-registry.js';
import { originalSession } from '../../../src/lib/original-session.js';
import { onProxyCacheInvalidate, useMiEnvironment, getMiEnvironment } from '../../../src/lib/proxy-cache.middleware.js';

/**
 * PP-4840: a `pp-dev` restart for another MI instance sets the users, the login and the proxy cache
 * up for it before it can still fail. The server that stays gets its own back.
 */
describe('saveDevServerState', () => {
  /**
   * What a dev server's setup does for an MI instance: ties the users to it (and how they are kept,
   * here not in a file). The registry's context and how it is kept go together, as in a dev server:
   * set apart, another spec's keeping in a shared worker was put back with this one's users.
   */
  const setUpFor = (miUrl: string) =>
    startKeepingUsers({ persist: false, miAPI: {} as MiAPI, projectRoot: '/app', miUrl });
  const contextOf = (miUrl: string) => `${path.resolve('/app')}\n${miUrl}`;

  afterEach(() => {
    userRegistry.clear();
    originalSession.clear();
  });

  it("puts back the old instance's users, default user and renamed hosts, without the new one's", () => {
    setUpFor('https://mi');
    userRegistry.add({ name: 'alice', kind: 'token', token: 'mi-token' });
    userRegistry.add({ name: 'bob', kind: 'token', token: 'mi-token-2' });
    userRegistry.setDefaultUser('alice');
    userRegistry.replace('bob', { name: 'robert', kind: 'token', token: 'mi-token-2' });

    const restore = saveDevServerState();

    setUpFor('https://stg70');
    userRegistry.add({ name: 'target', kind: 'token', token: 'stg70-token' });

    restore();

    expect(userRegistry.context).toBe(contextOf('https://mi'));
    expect(userRegistry.list().map((user) => [user.name, user.token])).toEqual([
      ['alice', 'mi-token'],
      ['robert', 'mi-token-2'],
    ]);
    expect(userRegistry.defaultUser?.name).toBe('alice');
    expect(userRegistry.renamedTo('bob')).toBe('robert');
  });

  it('puts back the login on the main host when the setup was for another instance', () => {
    setUpFor('https://mi');
    originalSession.restoreState({
      ...originalSession.saveState(),
      state: 'active',
      session: 'mi-session',
    });

    const restore = saveDevServerState();

    // The setup for another instance forgets the login.
    setUpFor('https://stg70');
    expect(originalSession.session).toBeUndefined();

    restore();

    expect(originalSession.state).toBe('active');
    expect(originalSession.session).toBe('mi-session');
  });

  // The setup kept the MI instance (or never ran): the running server's changes meanwhile were undone,
  // a user removed brought back with its kept token, another default user dropped.
  it("leaves the running server's changes when the setup kept the instance", () => {
    setUpFor('https://mi');
    userRegistry.add({ name: 'alice', kind: 'token', token: 'mi-token' });
    userRegistry.add({ name: 'bob', kind: 'token', token: 'mi-token-2' });

    const restore = saveDevServerState();

    userRegistry.remove('alice');
    userRegistry.setDefaultUser('bob');
    restore();

    expect(userRegistry.list().map((user) => user.name)).toEqual(['bob']);
    expect(userRegistry.defaultUser?.name).toBe('bob');
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
