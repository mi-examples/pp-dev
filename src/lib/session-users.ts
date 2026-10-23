/**
 * Session users (PP-4596): users that log in with a username and password, through MI's usual
 * login page on their own host. pp-dev never sees the password; it learns about the login, and
 * about the session ending, from the responses MI sends to that host.
 */
import type { IncomingMessage } from 'node:http';
import { MiAPI } from './pp.middleware.js';
import { SavedUser, UserRegistry, getUserNameFromHost } from './user-registry.js';
import { MI_SESSION_COOKIE, getRequestCookie, getSetCookieValue } from './helpers/cookie.helper.js';
import { createLogger } from './logger.js';
import { colors } from './helpers/color.helper.js';

/** Where MI sends a request whose session is gone. */
const LOGIN_LOCATION_REGEXP = /(?:^|\/\/[^/]+)\/(?:login|auth\/saml\/login)(?:[/?#]|$)/i;

/** The MI user an MI session belongs to, or `undefined` for a guest (not logged in) session. */
export type SessionCheck = (session: string) => Promise<{ id: number; username: string } | undefined>;

/** Asks MI who a session belongs to, the way the API token check does for tokens. */
export function createSessionCheck(miAPI: MiAPI): SessionCheck {
  return async (session) => {
    try {
      const response = await miAPI.get<{ user?: { user_id?: unknown; username?: unknown } }>(
        '/data/page/index/auth/info',
        {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Cookie: `${MI_SESSION_COOKIE}=${session}`,
        },
        true,
      );
      const user = response.data?.user;

      return typeof user?.user_id === 'number'
        ? { id: user.user_id, username: typeof user.username === 'string' ? user.username : '' }
        : undefined;
    } catch {
      return undefined;
    }
  };
}

/** A `Cookie` header with the MI session set to `session`, the other cookies kept. */
export function withSessionCookie(cookieHeader: string | undefined, session: string): string {
  const others = (cookieHeader ?? '')
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair && pair.split('=', 1)[0].trim() !== MI_SESSION_COOKIE);

  return [...others, `${MI_SESSION_COOKIE}=${session}`].join('; ');
}

/** `Set-Cookie` headers without the MI session cookie, or `undefined` if nothing is left. */
export function withoutSessionSetCookie(setCookie: string[] | undefined): string[] | undefined {
  const others = (setCookie ?? []).filter((cookie) => getSetCookieValue(cookie, MI_SESSION_COOKIE) === undefined);

  return others.length ? others : undefined;
}

interface ObservedResponse {
  statusCode?: number;
  headers: IncomingMessage['headers'];
}

/** Whether MI turned a request away for not being logged in. */
function isLoggedOutResponse({ statusCode = 200, headers }: ObservedResponse): boolean {
  if (statusCode === 401) {
    return true;
  }

  return statusCode >= 300 && statusCode < 400 && LOGIN_LOCATION_REGEXP.test(String(headers.location ?? ''));
}

/**
 * Follows the session users through the responses MI sends them:
 *
 * - a new MI session id on a session user's host is checked with MI; one that belongs to an MI
 *   user means the user logged in (`active`), and the session is kept for it;
 * - once logged in, MI turning a request away (a redirect to the login page, a 401, or a new
 *   guest session) means the session ended (`expired`), until the user logs in again on its host.
 */
export class SessionUserTracker {
  readonly #users: UserRegistry;

  readonly #check: SessionCheck;

  readonly #logger = createLogger();

  /** The session id each user's latest check is about, so an older answer can't win. */
  readonly #checking = new Map<string, string>();

  constructor(users: UserRegistry, check: SessionCheck) {
    this.#users = users;
    this.#check = check;
  }

  /**
   * Looks at a proxied response of `user`. Returns the pending session check, if this response
   * started one (tests wait for it; the proxy doesn't).
   */
  observe(user: SavedUser, req: IncomingMessage, res: ObservedResponse): Promise<void> | undefined {
    if (user.kind !== 'session') {
      return undefined;
    }

    // On its own host the browser holds the user's session; on the main host (as the default user)
    // the proxy sent the kept one.
    const onOwnHost = getUserNameFromHost(req.headers.host) === user.name;
    const sentSession = onOwnHost ? getRequestCookie(req.headers.cookie, MI_SESSION_COOKIE) : user.session;
    const newSession = getSetCookieValue(res.headers['set-cookie'], MI_SESSION_COOKIE);

    if (newSession && newSession !== sentSession && newSession !== user.session) {
      return this.#verify(user, newSession);
    }

    if (user.state === 'active' && isLoggedOutResponse(res)) {
      this.#expire(user, `MI turned away ${req.method} ${req.url}`);
    }

    return undefined;
  }

  async #verify(user: SavedUser, session: string): Promise<void> {
    this.#checking.set(user.name, session);

    const miUser = await this.#check(session);

    // A newer session came in meanwhile, or the user is gone.
    if (this.#checking.get(user.name) !== session || this.#users.get(user.name) !== user) {
      return;
    }

    this.#checking.delete(user.name);

    if (miUser) {
      const wasActive = user.state === 'active';

      Object.assign(user, { state: 'active', session, miUser });

      if (!wasActive) {
        this.#logger.info(
          `${colors.blue('User')} ${colors.yellow(user.name)} ${colors.blue('logged in')} (MI user ${miUser.id}${
            miUser.username ? `, ${miUser.username}` : ''
          })`,
        );
      }
    } else if (user.state === 'active') {
      this.#expire(user, 'MI started a guest session');
    }
  }

  #expire(user: SavedUser, reason: string): void {
    user.state = 'expired';
    user.session = undefined;

    // The main host can't go on as a user without a session.
    if (this.#users.defaultUser === user) {
      this.#users.setDefaultUser(undefined);
    }

    this.#logger.warn(
      `${colors.yellow(`The MI session of user ${user.name} ended`)} (${reason}). Log in again on its host.`,
    );
  }
}
