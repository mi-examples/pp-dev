import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  UserRegistry,
  createUserHostGuard,
  getUserNameError,
  getUserNameFromHost,
  MAX_USER_NAME_LENGTH,
} from '../../../src/lib/user-registry.js';

const req = (host?: string) => ({ headers: host === undefined ? {} : { host } }) as IncomingMessage;

describe('getUserNameError', () => {
  it.each(['u2', 'qa', 'viewer-1', 'a', 'a'.repeat(MAX_USER_NAME_LENGTH)])('accepts "%s"', (name) => {
    expect(getUserNameError(name)).toBeUndefined();
  });

  it.each([
    ['', 'empty'],
    ['2users', 'starts with a digit'],
    ['-qa', 'starts with "-"'],
    ['qa-', 'ends with "-"'],
    ['QA', 'uppercase'],
    ['john.doe', 'a dot'],
    ['john@example.com', 'an email'],
    ['ivan_b', 'an underscore'],
    ['юзер', 'non-latin letters'],
    ['a'.repeat(MAX_USER_NAME_LENGTH + 1), 'too long'],
  ])('rejects "%s" (%s)', (name) => {
    expect(getUserNameError(name)).toEqual(expect.any(String));
  });
});

describe('getUserNameFromHost', () => {
  it.each([
    ['u2.localhost:3000', 'u2'],
    ['u2.localhost', 'u2'],
    ['QA.LOCALHOST:5173', 'qa'],
  ])('reads the user of %s', (host, name) => {
    expect(getUserNameFromHost(host)).toBe(name);
  });

  it.each([
    undefined,
    '',
    'localhost',
    'localhost:3000',
    '127.0.0.1:3000',
    '[::1]:3000',
    'a.b.localhost:3000',
    'mi.example.com',
    'localhost.example.com',
  ])('finds no user in %s', (host) => {
    expect(getUserNameFromHost(host)).toBeUndefined();
  });
});

describe('UserRegistry', () => {
  let users: UserRegistry;

  beforeEach(() => {
    users = new UserRegistry();
  });

  it('adds, lists and removes users', () => {
    users.add({ name: 'viewer', kind: 'token', token: 't-viewer' });
    users.add({ name: 'qa', kind: 'session' });

    expect(users.list().map((user) => user.name)).toEqual(['viewer', 'qa']);
    expect(users.get('viewer')?.token).toBe('t-viewer');

    expect(users.remove('viewer')).toBe(true);
    expect(users.remove('viewer')).toBe(false);
    expect(users.list().map((user) => user.name)).toEqual(['qa']);
  });

  it('rejects an invalid name, a taken name and a token user without a token', () => {
    expect(() => users.add({ name: 'John Doe', kind: 'session' })).toThrow();

    users.add({ name: 'qa', kind: 'session' });

    expect(() => users.add({ name: 'qa', kind: 'token', token: 't' })).toThrow(/already exists/);
    expect(() => users.add({ name: 'viewer', kind: 'token' })).toThrow(/API token/);
  });

  it('resolves the main host to the original user', () => {
    expect(users.resolve(req('localhost:3000'))).toEqual({ key: '', user: undefined });
    expect(users.resolve(req('127.0.0.1:3000'))).toEqual({ key: '', user: undefined });
    expect(users.resolve(req())).toEqual({ key: '', user: undefined });
  });

  it("resolves a user's host to that user", () => {
    const viewer = users.add({ name: 'viewer', kind: 'token', token: 't-viewer' });

    expect(users.resolve(req('viewer.localhost:3000'))).toEqual({ key: 'viewer', user: viewer });
  });

  it('resolves a user host with no saved user to nobody', () => {
    expect(users.resolve(req('ghost.localhost:3000'))).toBeUndefined();
  });

  it('resolves the main host to the default user, and back to the original user', () => {
    const viewer = users.add({ name: 'viewer', kind: 'token', token: 't-viewer' });

    users.setDefaultUser('viewer');

    expect(users.defaultUser).toBe(viewer);
    expect(users.resolve(req('localhost:3000'))).toEqual({ key: 'viewer', user: viewer });

    users.setDefaultUser(undefined);

    expect(users.resolve(req('localhost:3000'))?.user).toBeUndefined();
  });

  it('only makes a known user the default, a session user once it has logged in', () => {
    const qa = users.add({ name: 'qa', kind: 'session' });

    expect(qa.state).toBe('pending');
    expect(() => users.setDefaultUser('ghost')).toThrow(/no user/);
    expect(() => users.setDefaultUser('qa')).toThrow(/log in/);

    Object.assign(qa, { state: 'active', session: 'S1' });
    users.setDefaultUser('qa');

    expect(users.defaultUser).toBe(qa);
  });

  it('tells listeners about every removed user', () => {
    const removed: string[] = [];
    const unsubscribe = users.onRemove((user) => removed.push(user.name));

    users.add({ name: 'viewer', kind: 'token', token: 't-viewer' });
    users.add({ name: 'qa', kind: 'session' });
    users.add({ name: 'admin', kind: 'session' });

    users.remove('viewer');
    users.remove('ghost');
    users.clear();
    unsubscribe();
    users.add({ name: 'late', kind: 'session' });
    users.remove('late');

    expect(removed).toEqual(['viewer', 'qa', 'admin']);
  });

  it('tells change listeners about every user added and removed', () => {
    const onChange = vi.fn();

    users.onChange(onChange);
    users.add({ name: 'viewer', kind: 'token', token: 't-viewer' });
    users.remove('viewer');
    users.remove('ghost');

    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('does not make a token user MI turned down the default', () => {
    users.add({ name: 'viewer', kind: 'token', token: 't-viewer', state: 'expired' });

    expect(() => users.setDefaultUser('viewer')).toThrow(/turned down/);
  });

  it('drops every user when the project or MI instance changes, and keeps them otherwise', () => {
    users.useContext('/work/app\nhttps://mi-a.example.com');
    users.add({ name: 'viewer', kind: 'token', token: 't-viewer' });
    users.setDefaultUser('viewer');

    users.useContext('/work/app\nhttps://mi-a.example.com');
    expect(users.list()).toHaveLength(1);

    users.useContext('/work/app\nhttps://mi-b.example.com');
    expect(users.list()).toEqual([]);
    expect(users.defaultUser).toBeUndefined();
  });

  it('reports session changes only for users it still has', () => {
    const listener = vi.fn();
    const qa = users.add({ name: 'qa', kind: 'session' });

    users.onSessionChange(listener);
    users.sessionChanged(qa);
    users.remove('qa');
    users.sessionChanged(qa);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('drops the default user when it is removed', () => {
    users.add({ name: 'viewer', kind: 'token', token: 't-viewer' });
    users.setDefaultUser('viewer');
    users.remove('viewer');

    expect(users.defaultUser).toBeUndefined();
  });
});

describe('createUserHostGuard', () => {
  function run(users: UserRegistry, host: string) {
    const res = {
      statusCode: 200,
      headers: {} as Record<string, unknown>,
      body: undefined as string | undefined,
      setHeader(name: string, value: unknown) {
        res.headers[name.toLowerCase()] = value;
      },
      end(body?: string) {
        res.body = body;
      },
    };
    const next = vi.fn();

    createUserHostGuard(users)(req(host), res as unknown as ServerResponse, next);

    return { res, next };
  }

  it('lets the main host and saved users through', () => {
    const users = new UserRegistry();

    users.add({ name: 'viewer', kind: 'token', token: 't-viewer' });

    expect(run(users, 'localhost:3000').next).toHaveBeenCalledOnce();
    expect(run(users, 'viewer.localhost:3000').next).toHaveBeenCalledOnce();
  });

  it('answers 404 for a user host with no saved user', () => {
    const { res, next } = run(new UserRegistry(), 'ghost.localhost:3000');

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('"ghost"');
  });
});
