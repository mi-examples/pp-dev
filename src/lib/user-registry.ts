/**
 * Users the developer works with besides their own (PP-4592).
 *
 * Every saved user gets its own host, `<name>.localhost:<port>`. A browser keeps cookies and storage
 * per host and carries the host on every request of a tab (fetches, images, links, reloads, tabs
 * opened from it), so the proxy can tell the user of any request from its `Host` header alone, and
 * a user's MI session never mixes with another's.
 *
 * The main host (`localhost:<port>`) belongs to the default user: the original user (the configured
 * API token) unless another user is made the default. The dev panel always works as the original
 * user, whatever host it runs on.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export type SavedUserKind = 'token' | 'session';

export interface SavedUser {
  /** The name given in the dev panel; also the first label of the user's host. */
  name: string;
  /** `token`: the proxy sends {@link SavedUser.token}; `session`: the browser's MI session on the user's host. */
  kind: SavedUserKind;
  /** API token of a `token` user. Never logged or sent back to the browser. */
  token?: string;
}

/** The identity a request goes to MI as. */
export interface RequestUser {
  /** Separates per-user state such as the proxy cache: the user's name, or `''` for the original user. */
  key: string;
  /** The saved user, or `undefined` for the original user. */
  user?: SavedUser;
}

const USER_HOST_SUFFIX = '.localhost';

/** Longest user name; well under the 63 characters a DNS label allows. */
export const MAX_USER_NAME_LENGTH = 32;

/** A DNS label: lowercase latin letters, digits and `-`, starting with a letter and not ending with `-`. */
const USER_NAME_REGEXP = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;

/** Why `name` can't be a user name, or `undefined` if it can. */
export function getUserNameError(name: string): string | undefined {
  if (!name) {
    return 'The name is required';
  }

  if (name.length > MAX_USER_NAME_LENGTH) {
    return `The name must be at most ${MAX_USER_NAME_LENGTH} characters long`;
  }

  if (!USER_NAME_REGEXP.test(name)) {
    return 'The name may contain only lowercase latin letters, digits and "-", must start with a letter and must not end with "-"';
  }

  return undefined;
}

/**
 * The user name in a `Host` header of a user's host (`u2.localhost:3000` → `u2`), or `undefined`
 * for any other host, the main `localhost` included.
 */
export function getUserNameFromHost(host: string | undefined): string | undefined {
  if (!host) {
    return undefined;
  }

  const hostname = host.toLowerCase().replace(/:\d+$/, '');

  if (!hostname.endsWith(USER_HOST_SUFFIX)) {
    return undefined;
  }

  const name = hostname.slice(0, -USER_HOST_SUFFIX.length);

  // `a.b.localhost` is not a user host: a user name is a single label.
  return name && !name.includes('.') ? name : undefined;
}

export class UserRegistry {
  readonly #users = new Map<string, SavedUser>();

  #defaultUserName: string | undefined;

  list(): SavedUser[] {
    return [...this.#users.values()];
  }

  get(name: string): SavedUser | undefined {
    return this.#users.get(name);
  }

  add(user: SavedUser): SavedUser {
    const error = getUserNameError(user.name);

    if (error) {
      throw new Error(error);
    }

    if (this.#users.has(user.name)) {
      throw new Error(`A user named "${user.name}" already exists`);
    }

    if (user.kind === 'token' && !user.token) {
      throw new Error('A token user needs an API token');
    }

    const saved = { ...user };

    this.#users.set(saved.name, saved);

    return saved;
  }

  remove(name: string): boolean {
    if (this.#defaultUserName === name) {
      this.#defaultUserName = undefined;
    }

    return this.#users.delete(name);
  }

  clear(): void {
    this.#users.clear();
    this.#defaultUserName = undefined;
  }

  /** The user of the main host, or `undefined` while it is the original user. */
  get defaultUser(): SavedUser | undefined {
    return this.#defaultUserName === undefined ? undefined : this.#users.get(this.#defaultUserName);
  }

  /**
   * Makes `name` the user of the main host, or the original user again with `undefined`. Only a token
   * user can be the default for now: a session user's MI session lives in its own host's cookies,
   * which the main host doesn't get.
   */
  setDefaultUser(name: string | undefined): void {
    if (name === undefined) {
      this.#defaultUserName = undefined;

      return;
    }

    const user = this.#users.get(name);

    if (!user) {
      throw new Error(`There is no user named "${name}"`);
    }

    if (user.kind !== 'token') {
      throw new Error('Only a user added with an API token can be the default user');
    }

    this.#defaultUserName = name;
  }

  /**
   * Who `req` goes to MI as. `undefined` for a user host with no saved user behind it (a stale or
   * mistyped link), which must not fall back to anyone's identity.
   */
  resolve(req: Pick<IncomingMessage, 'headers'>): RequestUser | undefined {
    const name = getUserNameFromHost(req.headers.host);

    if (name === undefined) {
      const user = this.defaultUser;

      return { key: user?.name ?? '', user };
    }

    const user = this.#users.get(name);

    return user ? { key: user.name, user } : undefined;
  }
}

export const userRegistry = new UserRegistry();

/**
 * Answers every request to a user host that has no saved user behind it, instead of serving the
 * page as nobody in particular. Works for both the Vite and the Next.js dev servers.
 */
export function createUserHostGuard(registry: UserRegistry = userRegistry) {
  return (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    if (registry.resolve(req)) {
      next();

      return;
    }

    const name = getUserNameFromHost(req.headers.host) ?? '';

    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(`pp-dev has no user named "${name}". Open users from the pp-dev dev panel on the main host.`);
  };
}
