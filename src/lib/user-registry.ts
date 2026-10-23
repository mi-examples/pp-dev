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
import { isSecureRequest } from './helpers/cookie.helper.js';

export type SavedUserKind = 'token' | 'session';

/**
 * Where a session user is: `pending` until it logs in on its host, `active` while its MI session
 * lasts, `expired` once MI ends it (log in again on the same host).
 */
export type SessionState = 'pending' | 'active' | 'expired';

export interface SavedUser {
  /** The name given in the dev panel; also the first label of the user's host. */
  name: string;
  /** `token`: the proxy sends {@link SavedUser.token}; `session`: the browser's MI session on the user's host. */
  kind: SavedUserKind;
  /** API token of a `token` user. Never logged or sent back to the browser. */
  token?: string;
  /**
   * State of a `session` user. A `token` user has none, or `expired` when MI turned down its kept
   * token on a dev server restart.
   */
  state?: SessionState;
  /**
   * MI session id of an `active` session user, seen when it logged in on its host. Kept in memory
   * only, to check the session and to send the main host as this user when it is the default.
   * Never logged or sent back to the browser.
   */
  session?: string;
  /** The MI user behind it, for display. */
  miUser?: { id: number; username: string };
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
/**
 * Whether `host` is the main host, `localhost`, the one the default user works on. An IP address
 * or a custom domain has no user hosts next to it and always goes as the original user.
 */
export function isMainHost(host: string | undefined): boolean {
  return (host ?? '').toLowerCase().replace(/:\d+$/, '') === 'localhost';
}

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

/**
 * The origin of `name`'s host (`http://<name>.localhost:<port>`), or of the main host
 * (`http://localhost:<port>`) without a name, on the scheme and port `req` came in on.
 */
export function getUserOrigin(req: IncomingMessage, name?: string): string {
  const port = /:(\d+)$/.exec(req.headers.host ?? '')?.[1];

  return `${isSecureRequest(req) ? 'https' : 'http'}://${name ? `${name}.` : ''}localhost${port ? `:${port}` : ''}`;
}

export class UserRegistry {
  readonly #users = new Map<string, SavedUser>();

  readonly #removeListeners = new Set<(user: SavedUser) => void>();

  readonly #changeListeners = new Set<() => void>();

  readonly #sessionChangeListeners = new Set<(user: SavedUser) => void>();

  #defaultUserName: string | undefined;

  /** Who each request goes as, decided once, when it is first asked (see {@link resolve}). */
  readonly #resolved = new WeakMap<object, RequestUser | undefined>();

  #context: string | undefined;

  /**
   * Ties the users to a project and MI instance. Switching to another one (a dev server restart with
   * another `mi.url`, in the same process) drops every user: their tokens and sessions belong to
   * the old instance and must not be sent to the new one.
   */
  useContext(context: string): void {
    if (this.#context !== undefined && this.#context !== context) {
      this.clear();
    }

    this.#context = context;
  }

  /** The context set by {@link useContext}. */
  get context(): string | undefined {
    return this.#context;
  }

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

    const saved: SavedUser = user.kind === 'session' ? { state: 'pending', ...user } : { ...user };

    this.#users.set(saved.name, saved);
    this.#changeListeners.forEach((listener) => listener());

    return saved;
  }

  remove(name: string): boolean {
    const user = this.#users.get(name);

    if (!user) {
      return false;
    }

    if (this.#defaultUserName === name) {
      this.#defaultUserName = undefined;
    }

    this.#users.delete(name);
    this.#removeListeners.forEach((listener) => listener(user));
    this.#changeListeners.forEach((listener) => listener());

    return true;
  }

  clear(): void {
    for (const name of [...this.#users.keys()]) {
      this.remove(name);
    }
  }

  /** Runs `listener` for every user removed, e.g. to drop what is cached for it. Returns an unsubscribe function. */
  onRemove(listener: (user: SavedUser) => void): () => void {
    this.#removeListeners.add(listener);

    return () => {
      this.#removeListeners.delete(listener);
    };
  }

  /**
   * Runs `listener` when a saved user's MI session changes or ends, so what is cached for it can be
   * dropped. Returns an unsubscribe function.
   */
  onSessionChange(listener: (user: SavedUser) => void): () => void {
    this.#sessionChangeListeners.add(listener);

    return () => {
      this.#sessionChangeListeners.delete(listener);
    };
  }

  /** Tells the {@link onSessionChange} listeners that `user`'s MI session changed or ended. */
  sessionChanged(user: SavedUser): void {
    if (this.#users.get(user.name) === user) {
      this.#sessionChangeListeners.forEach((listener) => listener(user));
    }
  }

  /** Runs `listener` whenever a user is added or removed. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);

    return () => {
      this.#changeListeners.delete(listener);
    };
  }

  /** The user of the main host, or `undefined` while it is the original user. */
  get defaultUser(): SavedUser | undefined {
    return this.#defaultUserName === undefined ? undefined : this.#users.get(this.#defaultUserName);
  }

  /**
   * Makes `name` the user of the main host, or the original user again with `undefined`. A session
   * user needs to be logged in: the main host is sent with the MI session it logged in with.
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

    if (user.kind === 'session' && (user.state !== 'active' || !user.session)) {
      throw new Error(`"${name}" has to log in on its own host before it can be the default user`);
    }

    if (user.kind === 'token' && user.state === 'expired') {
      throw new Error(`MI turned down the API token of "${name}"`);
    }

    this.#defaultUserName = name;
  }

  /**
   * Who `req` goes to MI as. `undefined` for a user host with no saved user behind it (a stale or
   * mistyped link), which must not fall back to anyone's identity.
   *
   * Decided once per request, when it is first asked, and the same answer after that: the cache,
   * the proxy and the Request Inspector look at a request at different moments (a page-data load
   * can come in between), and a default user changed meanwhile must not make one of them file
   * the request under another user than the one it went to MI as.
   */
  resolve(req: Pick<IncomingMessage, 'headers'>): RequestUser | undefined {
    if (this.#resolved.has(req)) {
      return this.#resolved.get(req);
    }

    const name = getUserNameFromHost(req.headers.host);
    let requestUser: RequestUser | undefined;

    if (name === undefined) {
      const user = isMainHost(req.headers.host) ? this.defaultUser : undefined;

      requestUser = { key: user?.name ?? '', user };
    } else {
      const user = this.#users.get(name);

      requestUser = user ? { key: user.name, user } : undefined;
    }

    this.#resolved.set(req, requestUser);

    return requestUser;
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
