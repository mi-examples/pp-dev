/**
 * Session users (PP-4596): users that log in with a username and password, through MI's usual
 * login page on their own host. pp-dev never sees the password; it learns about the login, and
 * about the session ending, from the responses MI sends to that host.
 */
import type { IncomingMessage } from 'node:http';
import { MiAPI } from './pp.middleware.js';
import { SavedUser, UserRegistry, getUserNameFromHost } from './user-registry.js';
import { MI_SESSION_COOKIE, getRequestCookie, getSetCookieValue } from './helpers/cookie.helper.js';
import { getTokenErrorInfo } from './helpers/token.helper.js';
import { createLogger } from './logger.js';
import { colors } from './helpers/color.helper.js';

/** Where MI sends a request whose session is gone. */
const LOGIN_LOCATION_REGEXP = /(?:^|\/\/[^/]+)\/(?:login|auth\/saml\/login)(?:[/?#]|$)/i;

/**
 * The MI user an MI session belongs to, or `undefined` for a guest (not logged in) session. Throws
 * when MI can't tell (down, timing out, a server error): that says nothing about the session.
 */
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
    } catch (error) {
      const { status } = getTokenErrorInfo(error);

      // MI turned the session down; anything else is MI not answering.
      if (status === 401 || status === 403 || status === 412) {
        return undefined;
      }

      throw error;
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

/**
 * Whether MI turned a request away for not being logged in: a 401, a 412 (how MI answers an expired
 * session, see helpers/token.helper.ts), or a redirect to the login page.
 */
function isLoggedOutResponse({ statusCode = 200, headers }: ObservedResponse): boolean {
  if (statusCode === 401 || statusCode === 412) {
    return true;
  }

  return statusCode >= 300 && statusCode < 400 && LOGIN_LOCATION_REGEXP.test(String(headers.location ?? ''));
}

/**
 * Follows the session users through the responses MI sends them:
 *
 * - an MI session not yet known for a session user is checked with MI: a new one MI hands its host,
 *   or, while the user isn't logged in, the one its host's cookies already carry (they outlive a
 *   dev server restart or removing the user). One that belongs to an MI user means the user logged
 *   in (`active`), and the session is kept for it;
 * - once logged in, MI turning a request away (a redirect to the login page, a 401 or 412, or a new
 *   guest session) means the session ended (`expired`), until the user logs in again on its host.
 *
 * Every new or ended session is reported to the registry, so the user's cached responses go too.
 */
export class SessionUserTracker {
  readonly #users: UserRegistry;

  readonly #check: SessionCheck;

  readonly #logger = createLogger();

  /** The session id each user's latest check is about, so an older answer can't win. */
  readonly #checking = new Map<string, string>();

  /** The last session id per user that MI said is a guest one, so it isn't checked over and over. */
  readonly #guestSessions = new Map<string, string>();

  constructor(users: UserRegistry, check: SessionCheck) {
    this.#users = users;
    this.#check = check;
  }

  /**
   * Looks at a proxied response of `user`. `sentSession` is the MI session the proxy put in the
   * request for a session user sent from the main host. Returns the pending session check, if this
   * response started one (tests wait for it; the proxy doesn't).
   */
  observe(
    user: SavedUser,
    req: IncomingMessage,
    res: ObservedResponse,
    sentSession?: string,
  ): Promise<void> | undefined {
    // Removed, or removed and added again, while the request was in flight.
    if (user.kind !== 'session' || this.#users.get(user.name) !== user) {
      return undefined;
    }

    // On its own host the browser holds the user's session; on the main host (as the default user)
    // the proxy sent the kept one.
    const onOwnHost = getUserNameFromHost(req.headers.host) === user.name;
    const requestSession = onOwnHost ? getRequestCookie(req.headers.cookie, MI_SESSION_COOKIE) : sentSession;
    const newSession = getSetCookieValue(res.headers['set-cookie'], MI_SESSION_COOKIE);
    let candidate: string | undefined;

    if (newSession && newSession !== requestSession) {
      candidate = newSession;
    } else if (onOwnHost && user.state !== 'active' && !isLoggedOutResponse(res)) {
      // MI kept (or didn't set) the session the host already carries: it may be logged in already.
      candidate = requestSession;
    }

    if (
      candidate &&
      candidate !== user.session &&
      candidate !== this.#checking.get(user.name) &&
      candidate !== this.#guestSessions.get(user.name)
    ) {
      return this.#verify(user, candidate);
    }

    if (user.state === 'active' && isLoggedOutResponse(res)) {
      this.#expire(user, `MI turned away ${req.method} ${req.url}`);
    }

    return undefined;
  }

  async #verify(user: SavedUser, session: string): Promise<void> {
    this.#checking.set(user.name, session);

    let miUser: Awaited<ReturnType<SessionCheck>>;

    try {
      miUser = await this.#check(session);
    } catch (error) {
      // MI couldn't tell: neither a login nor a guest. A later response checks the session again.
      if (this.#checking.get(user.name) === session) {
        this.#checking.delete(user.name);
      }

      this.#logger.warn(colors.yellow(`Could not check the MI session of user ${user.name}: ${String(error)}`));

      return;
    }

    // A newer session came in meanwhile, the user expired, or it is gone.
    if (this.#checking.get(user.name) !== session || this.#users.get(user.name) !== user) {
      return;
    }

    this.#checking.delete(user.name);

    if (miUser) {
      const wasActive = user.state === 'active';

      Object.assign(user, { state: 'active', session, miUser });
      this.#guestSessions.delete(user.name);
      // What was cached before belongs to another session (a guest, or another MI user).
      this.#users.sessionChanged(user);

      if (!wasActive) {
        this.#logger.info(
          `${colors.blue('User')} ${colors.yellow(user.name)} ${colors.blue('logged in')} (MI user ${miUser.id}${
            miUser.username ? `, ${miUser.username}` : ''
          })`,
        );
      }
    } else {
      this.#guestSessions.set(user.name, session);

      if (user.state === 'active') {
        this.#expire(user, 'MI started a guest session');
      }
    }
  }

  #expire(user: SavedUser, reason: string): void {
    user.state = 'expired';
    user.session = undefined;
    // A check still running for an earlier session must not bring the user back.
    this.#checking.delete(user.name);
    this.#users.sessionChanged(user);

    // The main host can't go on as a user without a session.
    if (this.#users.defaultUser === user) {
      this.#users.setDefaultUser(undefined);
    }

    this.#logger.warn(
      `${colors.yellow(`The MI session of user ${user.name} ended`)} (${reason}). Log in again on its host.`,
    );
  }
}
