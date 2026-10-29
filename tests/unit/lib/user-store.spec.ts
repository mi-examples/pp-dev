import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getUserStorePath, keepTokenUsers, readStoredUsers, writeStoredUsers } from '../../../src/lib/user-store.js';
import { UserRegistry } from '../../../src/lib/user-registry.js';
import type { TokenCheck } from '../../../src/lib/mi-identity.js';

/** PP-4600: token users kept between dev server runs, in a file in the home directory. */

const MI_URL = 'https://mi.example.com';

describe('getUserStorePath', () => {
  it('keeps one file per project and MI instance, under ~/.pp-dev/users', () => {
    const home = path.join(path.sep, 'home', 'dev');
    const a = getUserStorePath('/work/app-a', MI_URL, home);

    expect(path.dirname(a)).toBe(path.join(home, '.pp-dev', 'users'));
    expect(a).toMatch(/[0-9a-f]{16}\.json$/);
    expect(getUserStorePath('/work/app-a', `${MI_URL}/`, home)).toBe(a);
    expect(getUserStorePath('/work/app-b', MI_URL, home)).not.toBe(a);
    expect(getUserStorePath('/work/app-a', 'https://other.example.com', home)).not.toBe(a);
  });
});

describe('keepTokenUsers', () => {
  let home: string;
  let users: UserRegistry;
  let file: string;
  let checkToken: ReturnType<typeof vi.fn<(token: string) => Promise<TokenCheck>>>;

  const keep = () => keepTokenUsers(users, { projectRoot: '/work/app', miUrl: MI_URL, checkToken, homeDir: home });
  const storedNames = () => readStoredUsers(file).map((user) => user.name);

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-users-'));
    users = new UserRegistry();
    file = getUserStorePath('/work/app', MI_URL, home);
    checkToken = vi.fn(async (token: string): Promise<TokenCheck> => {
      if (token === 'rejected-token') {
        return { ok: false, rejected: true, message: 'The API token was rejected' };
      }

      if (token === 'offline-token') {
        return { ok: false, rejected: false, message: 'Could not check the API token with MI' };
      }

      return { ok: true, miUser: { id: 42, username: `${token}@example.com` } };
    });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('saves the token users already there when keeping starts', async () => {
    users.add({ name: 'viewer', kind: 'token', token: 'viewer-token' });
    users.add({ name: 'qa', kind: 'session' });

    await keep();

    expect(storedNames()).toEqual(['viewer']);
  });

  it('saves token users as they are added and removed, never session users', async () => {
    await keep();

    users.add({ name: 'viewer', kind: 'token', token: 'viewer-token' });
    users.add({ name: 'qa', kind: 'session' });
    users.add({ name: 'admin', kind: 'token', token: 'admin-token' });

    expect(readStoredUsers(file)).toEqual([
      { name: 'viewer', token: 'viewer-token' },
      { name: 'admin', token: 'admin-token' },
    ]);

    users.remove('viewer');

    expect(storedNames()).toEqual(['admin']);
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('session');
  });

  it.skipIf(process.platform === 'win32')('keeps the file readable by its owner only', async () => {
    await keep();
    users.add({ name: 'viewer', kind: 'token', token: 'viewer-token' });

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('restores the saved users and checks their tokens with MI again', async () => {
    writeStoredUsers(
      file,
      [
        { name: 'viewer', token: 'viewer' },
        { name: 'gone', token: 'rejected-token' },
        { name: 'later', token: 'offline-token' },
      ],
      { project: '/work/app', miUrl: MI_URL },
    );

    await keep();

    expect(checkToken).toHaveBeenCalledTimes(3);
    expect(users.get('viewer')).toMatchObject({ kind: 'token', token: 'viewer', miUser: { id: 42 } });
    expect(users.get('viewer')?.state).toBeUndefined();
    expect(users.get('gone')?.state).toBe('expired');
    expect(users.get('later')).toMatchObject({ token: 'offline-token' });
    expect(users.get('later')?.state).toBeUndefined();
    // Restoring doesn't rewrite the file, nor drop anyone from it.
    expect(storedNames()).toEqual(['viewer', 'gone', 'later']);
  });

  it('skips saved users with a bad name or a name already taken', async () => {
    writeStoredUsers(
      file,
      [
        { name: 'Bad Name', token: 't1' },
        { name: 'viewer', token: 't2' },
      ],
      { project: '/work/app', miUrl: MI_URL },
    );
    users.add({ name: 'viewer', kind: 'session' });

    await keep();

    expect(users.list().map((user) => user.name)).toEqual(['viewer']);
    expect(users.get('viewer')?.kind).toBe('session');
  });

  it('starts empty from a missing or broken file', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');

    await keep();

    expect(users.list()).toEqual([]);
  });

  it.each(['null', '42', '[]', '{ "users": null }'])('reads %s as an empty store', (content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);

    expect(readStoredUsers(file)).toEqual([]);
  });

  it('keeps a user removed while its saved token was being checked removed', async () => {
    writeStoredUsers(file, [{ name: 'viewer', token: 'viewer' }], { project: '/work/app', miUrl: MI_URL });
    users.add({ name: 'viewer', kind: 'token', token: 'viewer' });

    let release!: () => void;

    checkToken.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ ok: true, miUser: { id: 1, username: 'v' } }))),
    );

    const restoring = keep();

    await vi.waitFor(() => expect(release).toBeDefined());
    users.remove('viewer');
    release();
    await restoring;

    expect(users.get('viewer')).toBeUndefined();
    expect(storedNames()).toEqual([]);
  });

  it('saves a user added while the saved tokens were being checked', async () => {
    writeStoredUsers(file, [{ name: 'viewer', token: 'viewer' }], { project: '/work/app', miUrl: MI_URL });

    let release!: () => void;

    checkToken.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ ok: true, miUser: { id: 1, username: 'v' } }))),
    );

    const restoring = keep();

    await vi.waitFor(() => expect(release).toBeDefined());
    users.add({ name: 'admin', kind: 'token', token: 'admin-token' });
    release();
    await restoring;

    expect(readStoredUsers(file)).toEqual([
      { name: 'admin', token: 'admin-token' },
      { name: 'viewer', token: 'viewer' },
    ]);
  });

  it('does not restore into a registry that moved to another project or MI meanwhile', async () => {
    writeStoredUsers(file, [{ name: 'viewer', token: 'viewer' }], { project: '/work/app', miUrl: MI_URL });

    let release!: () => void;

    checkToken.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ ok: true, miUser: { id: 1, username: 'v' } }))),
    );

    const restoring = keep();

    await vi.waitFor(() => expect(release).toBeDefined());
    // Another project's store takes the registry over.
    await keepTokenUsers(users, { projectRoot: '/work/other', miUrl: MI_URL, checkToken, homeDir: home });
    release();
    await restoring;

    expect(users.get('viewer')).toBeUndefined();
  });

  it('keeps a registry in one file only once', async () => {
    await keep();
    await keep();

    users.add({ name: 'viewer', kind: 'token', token: 'viewer-token' });

    expect(storedNames()).toEqual(['viewer']);
    expect(checkToken).not.toHaveBeenCalled();
  });

  // Two dev servers on one project and MI instance share the file, and the last one to write
  // dropped the users the other had added.
  it('keeps the users another dev server wrote to the same file', async () => {
    await keep();

    writeStoredUsers(file, [{ name: 'theirs', token: 'their-token' }], { project: '/work/app', miUrl: MI_URL });
    users.add({ name: 'viewer', kind: 'token', token: 'viewer-token' });

    expect(readStoredUsers(file)).toEqual([
      { name: 'viewer', token: 'viewer-token' },
      { name: 'theirs', token: 'their-token' },
    ]);
  });

  it('does not merge back a user removed or renamed here', async () => {
    writeStoredUsers(
      file,
      [
        { name: 'gone', token: 'gone-token' },
        { name: 'old-name', token: 'renamed-token' },
      ],
      { project: '/work/app', miUrl: MI_URL },
    );
    await keep();

    users.remove('gone');
    users.replace('old-name', { name: 'new-name', kind: 'token', token: 'renamed-token' });

    expect(storedNames()).toEqual(['new-name']);
  });

  // Each start for another file (another project or MI instance) added a pair of registry
  // listeners, and none was ever removed.
  it('removes its registry listeners when it starts keeping another file', async () => {
    let active = 0;
    const track = <T extends (...args: never[]) => () => void>(subscribe: T) =>
      ((listener: never) => {
        const unsubscribe = subscribe(listener);

        active += 1;

        return () => {
          active -= 1;
          unsubscribe();
        };
      }) as T;

    users.onChange = track(users.onChange.bind(users));
    users.onRemove = track(users.onRemove.bind(users));

    await keep();

    const afterFirst = active;

    await keepTokenUsers(users, { projectRoot: '/work/other-app', miUrl: MI_URL, checkToken, homeDir: home });
    await keepTokenUsers(users, { projectRoot: '/work/app', miUrl: MI_URL, checkToken, homeDir: home });

    expect(afterFirst).toBe(2);
    expect(active).toBe(2);
  });
});
