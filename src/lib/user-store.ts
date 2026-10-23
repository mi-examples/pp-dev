/**
 * Keeps token users between dev server runs (PP-4600), when `users.persist` is on.
 *
 * The file lives in the home directory, `~/.pp-dev/users/<hash>.json`, one per project and MI
 * instance, readable by its owner only. Outside the project it can't end up in git or in a build.
 * Only token users are kept (name and API token); passwords and MI sessions are never written.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserRegistry, getUserNameError, userRegistry } from './user-registry.js';
import { checkUserToken, type TokenCheck } from './user-routes.js';
import type { MiAPI } from './pp.middleware.js';
import { createLogger } from './logger.js';
import { colors } from './helpers/color.helper.js';

const STORE_VERSION = 1;

export interface StoredUser {
  name: string;
  token: string;
}

interface StoreFile {
  version: number;
  /** For whoever opens the file: which project and MI instance it belongs to. */
  project: string;
  miUrl: string;
  users: StoredUser[];
}

/** Where the users of `projectRoot` on `miUrl` are kept. */
export function getUserStorePath(projectRoot: string, miUrl: string, homeDir = os.homedir()): string {
  const hash = createHash('sha256')
    .update(`${path.resolve(projectRoot)}\n${miUrl.replace(/\/+$/, '')}`)
    .digest('hex')
    .slice(0, 16);

  return path.join(homeDir, '.pp-dev', 'users', `${hash}.json`);
}

/** The users kept in `file`; none when it is missing or unreadable. */
export function readStoredUsers(file: string): StoredUser[] {
  let parsed: Partial<StoreFile>;

  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      createLogger().warn(colors.yellow(`Could not read the saved users from ${file}: ${String(error)}`));
    }

    return [];
  }

  return (Array.isArray(parsed.users) ? parsed.users : []).filter(
    (user): user is StoredUser =>
      typeof user?.name === 'string' && typeof user.token === 'string' && Boolean(user.token),
  );
}

/** Writes `users` to `file`, readable by its owner only. */
export function writeStoredUsers(file: string, users: StoredUser[], meta: { project: string; miUrl: string }): void {
  const content: StoreFile = { version: STORE_VERSION, ...meta, users };
  const tmp = `${file}.${process.pid}.tmp`;

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Written aside and renamed over the old file, so a crash never leaves half a file.
  fs.writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  // `mode` only applies to new files; an older file keeps whatever it had.
  fs.chmodSync(file, 0o600);
}

/** Registries already kept in a file, so a dev server restart in the same process doesn't do it twice. */
const keptRegistries = new WeakMap<UserRegistry, string>();

/**
 * Restores the token users kept for this project and MI instance, then keeps the file in step with
 * every user added or removed. Every restored token is checked with MI again: one MI turns down
 * comes back `expired`; when MI can't be asked, the user comes back unchecked.
 */
export async function keepTokenUsers(
  users: UserRegistry,
  opts: { projectRoot: string; miUrl: string; checkToken: (token: string) => Promise<TokenCheck>; homeDir?: string },
): Promise<void> {
  const file = getUserStorePath(opts.projectRoot, opts.miUrl, opts.homeDir);
  const meta = { project: path.resolve(opts.projectRoot), miUrl: opts.miUrl };
  const logger = createLogger();

  if (keptRegistries.get(users) === file) {
    return;
  }

  keptRegistries.set(users, file);

  const stored = readStoredUsers(file);
  // Writing starts once the stored users are back, or the first write would drop them.
  let restoring = true;

  users.onChange(() => {
    if (restoring || keptRegistries.get(users) !== file) {
      return;
    }

    const tokenUsers = users
      .list()
      .filter((user) => user.kind === 'token' && user.token)
      .map((user) => ({ name: user.name, token: user.token! }));

    try {
      writeStoredUsers(file, tokenUsers, meta);
    } catch (error) {
      logger.warn(colors.yellow(`Could not save the users to ${file}: ${String(error)}`));
    }
  });

  try {
    const checks = await Promise.all(stored.map((user) => opts.checkToken(user.token)));

    stored.forEach((user, index) => {
      if (getUserNameError(user.name) || users.get(user.name)) {
        return;
      }

      const check = checks[index];

      users.add({
        name: user.name,
        kind: 'token',
        token: user.token,
        ...(check.ok ? { miUser: check.miUser } : {}),
        ...(!check.ok && check.rejected ? { state: 'expired' } : {}),
      });

      if (!check.ok) {
        logger.warn(colors.yellow(`Restored user ${user.name}: ${check.message}`));
      }
    });
  } finally {
    restoring = false;
  }

  if (stored.length) {
    logger.info(`${colors.blue('Restored')} ${stored.length} ${colors.blue('saved user(s) from')} ${file}`);
  }
}

/** Starts keeping the shared registry's token users when `users.persist` is on (Vite and Next.js). */
export function startKeepingUsers(opts: { persist: boolean; miAPI: MiAPI; projectRoot: string; miUrl: string }): void {
  if (!opts.persist) {
    return;
  }

  // Users can only be added with your own token, so without one there is nothing to restore.
  if (!opts.miAPI.personalAccessToken) {
    createLogger().warn(
      colors.yellow('users.persist is on, but users need your own API token (mi.token or MI_ACCESS_TOKEN).'),
    );

    return;
  }

  keepTokenUsers(userRegistry, {
    projectRoot: opts.projectRoot,
    miUrl: opts.miUrl,
    checkToken: (token) => checkUserToken(opts.miAPI, token),
  }).catch((error) => {
    createLogger().warn(colors.yellow(`Could not restore the saved users: ${String(error)}`));
  });
}
