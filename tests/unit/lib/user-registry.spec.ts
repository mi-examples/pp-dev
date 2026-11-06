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

  it('keeps an IP address or a custom domain as the original user, whatever the default', () => {
    users.add({ name: 'viewer', kind: 'token', token: 't-viewer' });
    users.setDefaultUser('viewer');

    expect(users.resolve(req('127.0.0.1:3000'))).toEqual({ key: '', user: undefined });
    expect(users.resolve(req('[::1]:3000'))).toEqual({ key: '', user: undefined });
    expect(users.resolve(req('dev.example.com'))).toEqual({ key: '', user: undefined });
    expect(users.resolve(req('LOCALHOST:3000'))?.key).toBe('viewer');
  });

  it('keeps a request with the user it was first resolved to, even if the default changes', () => {
    const viewer = users.add({ name: 'viewer', kind: 'token', token: 't-viewer' });
    const request = req('localhost:3000');

    expect(users.resolve(request)?.user).toBeUndefined();

    users.setDefaultUser('viewer');

    expect(users.resolve(request)?.user).toBeUndefined();
    expect(users.resolve(req('localhost:3000'))?.user).toBe(viewer);
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
  function run(users: UserRegistry, host: string, extra: Partial<IncomingMessage> = {}) {
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

    createUserHostGuard(users)({ ...req(host), ...extra } as IncomingMessage, res as unknown as ServerResponse, next);

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

  describe("a renamed user's old host", () => {
    const users = new UserRegistry();

    users.add({ name: 'viewer', kind: 'token', token: 't-viewer' });

    const reader = users.replace('viewer', { name: 'reader', kind: 'token', token: 't-viewer' });

    it('moves a page load to the new host', () => {
      const { res, next } = run(users, 'viewer.localhost:3000', {
        method: 'GET',
        url: '/pl/page?x=1',
        headers: { host: 'viewer.localhost:3000', 'sec-fetch-mode': 'navigate' },
      });

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('http://reader.localhost:3000/pl/page?x=1');
    });

    it('serves anything else right there, as the renamed user', () => {
      const fetch = { host: 'viewer.localhost:3000', 'sec-fetch-mode': 'cors' };

      expect(run(users, 'viewer.localhost:3000', { method: 'GET', headers: fetch }).next).toHaveBeenCalledOnce();
      expect(run(users, 'viewer.localhost:3000', { method: 'POST', headers: fetch }).next).toHaveBeenCalledOnce();
      expect(users.resolve(req('viewer.localhost:3000'))).toEqual({ key: 'reader', user: reader });
    });
  });
});

describe('UserRegistry.replace', () => {
  // A replace is a remove and an add: whoever follows the list (the token store, which writes its
  // file on each change) heard about it twice.
  it('notifies one change, once the new user is in place', () => {
    const users = new UserRegistry();

    users.add({ name: 'viewer', kind: 'token', token: 't-old' });

    const seen: (string | undefined)[] = [];

    users.onChange(() => seen.push(users.get('viewer')?.token));
    users.replace('viewer', { name: 'viewer', kind: 'token', token: 't-new' });

    expect(seen).toEqual(['t-new']);
  });

  it('puts a new registration in the place of the old one, keeping it the default', () => {
    const users = new UserRegistry();
    const removed = vi.fn();
    const old = users.add({ name: 'viewer', kind: 'token', token: 't-old' });

    users.setDefaultUser('viewer');
    users.onRemove(removed);

    const saved = users.replace('viewer', { name: 'viewer', kind: 'token', token: 't-new' });

    expect(saved).not.toBe(old);
    expect(removed).toHaveBeenCalledWith(old);
    expect(users.get('viewer')).toBe(saved);
    expect(users.defaultUser).toBe(saved);
    expect(users.renamedTo('viewer')).toBeUndefined();
  });

  it('remembers old names, through several renames, until the name is taken again or the user goes', () => {
    const users = new UserRegistry();

    users.add({ name: 'a', kind: 'token', token: 't' });
    users.replace('a', { name: 'b', kind: 'token', token: 't' });
    users.replace('b', { name: 'c', kind: 'token', token: 't' });

    expect(users.get('a')).toBeUndefined();
    expect([users.renamedTo('a'), users.renamedTo('b')]).toEqual(['c', 'c']);

    users.add({ name: 'a', kind: 'token', token: 't2' });

    expect(users.renamedTo('a')).toBeUndefined();

    users.remove('c');

    expect(users.renamedTo('b')).toBeUndefined();
  });

  it('refuses a bad or taken name, leaving the user as it was', () => {
    const users = new UserRegistry();
    const viewer = users.add({ name: 'viewer', kind: 'token', token: 't' });

    users.add({ name: 'qa', kind: 'session' });

    expect(() => users.replace('viewer', { name: 'qa', kind: 'token', token: 't' })).toThrow(/already exists/);
    expect(() => users.replace('viewer', { name: 'Bad_Name', kind: 'token', token: 't' })).toThrow();
    expect(users.get('viewer')).toBe(viewer);
  });
});
