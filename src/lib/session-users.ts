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

/** How long a session check MI couldn't answer waits before it is tried again. */
const RETRY_DELAY = 5000;

/** How many sessions a user left behind are remembered. */
const MAX_SUPERSEDED = 20;

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

/** The cookies of a `Cookie` header other than the MI session. */
function getOtherCookies(cookieHeader: string | undefined): string[] {
  return (cookieHeader ?? '')
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair && pair.split('=', 1)[0].trim() !== MI_SESSION_COOKIE);
}

/** A `Cookie` header with the MI session set to `session`, the other cookies kept. */
export function withSessionCookie(cookieHeader: string | undefined, session: string): string {
  return [...getOtherCookies(cookieHeader), `${MI_SESSION_COOKIE}=${session}`].join('; ');
}

/** A `Cookie` header without the MI session, or `undefined` if nothing is left. */
export function withoutSessionCookie(cookieHeader: string | undefined): string | undefined {
  const others = getOtherCookies(cookieHeader);

  return others.length ? others.join('; ') : undefined;
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
 *   or one its host's cookies carry that pp-dev hasn't recognized (cookies outlive a dev server
 *   restart or removing the user, and a rotation's check may have gone unanswered). One that
 *   belongs to an MI user means the user logged in (`active`), and the session is kept for it;
 * - once logged in, MI turning a request away (a redirect to the login page, a 401 or 412, or a new
 *   guest session) means the session ended (`expired`), until the user logs in again on its host.
 *
 * Every new or ended session is reported to the registry, so the user's cached responses go too.
 */
export class SessionUserTracker {
  readonly #users: UserRegistry;

  readonly #check: SessionCheck;

  readonly #logger = createLogger();

  /**
   * The session id each registration's latest check is about, so an older answer can't win. Kept
   * per registration, not per name: a user removed and added again starts afresh.
   */
  readonly #checking = new WeakMap<SavedUser, string>();

  /** The last session id per registration that MI said is a guest one, so it isn't checked over and over. */
  readonly #guestSessions = new WeakMap<SavedUser, string>();

  /**
   * A session MI handed out whose check couldn't be answered, per registration, checked again on
   * later responses. Without it a session MI rotated to on the main host (whose cookie never
   * reaches a browser) would be lost. It isn't used for requests until a check accepts it. Keeps
   * the session MI replaced with it, so a guest verdict that comes later still ends that one, and
   * whether it reached the user's host.
   */
  readonly #unverified = new WeakMap<
    SavedUser,
    { session: string; replaced?: string; ownHost: boolean; retryAt: number }
  >();

  /**
   * Sessions each registration's host held before a newer one reached it. A session MI hands out in
   * place of one of them is a late answer to a request sent before the user logged in again: it
   * must not take the newer login's place. A session MI rotated to on the main host isn't one: its
   * cookie never reaches the user's host, whose browser goes on with the older session, logs in
   * from it, and is taken at its word.
   */
  readonly #superseded = new WeakMap<SavedUser, Set<string>>();

  constructor(users: UserRegistry, check: SessionCheck) {
    this.#users = users;
    this.#check = check;
  }

  /**
   * Whether `req` went with a session the logged-in `user` already left behind (a request sent
   * before a newer login, answered late). A session MI hands out in its response belongs to that
   * older login: the proxy keeps it from the browser, which holds the newer one.
   */
  isLeftBehindRequest(user: SavedUser, req: IncomingMessage, sentSession?: string): boolean {
    const session =
      getUserNameFromHost(req.headers.host) === user.name
        ? getRequestCookie(req.headers.cookie, MI_SESSION_COOKIE)
        : sentSession;

    return session !== undefined && this.#isLeftBehind(user, session);
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
    const unverified = this.#unverified.get(user);
    let candidate: string | undefined;
    // The session MI replaced with `candidate`, when it handed one out in this response.
    let replaced: string | undefined;
    // Whether `candidate` is (or will be) in the browser of the user's host.
    let ownHost = onOwnHost;

    if (newSession && newSession !== requestSession) {
      candidate = newSession;
      replaced = requestSession;
    } else if (onOwnHost && requestSession !== user.session && !isLoggedOutResponse(res)) {
      // The host carries a session pp-dev hasn't recognized: one that outlived a restart or a
      // removal, or one MI rotated to while its check couldn't be answered.
      candidate = requestSession;
    } else if (unverified && Date.now() >= unverified.retryAt) {
      candidate = unverified.session;
      ownHost = unverified.ownHost;
    }

    // Checked again (on a retry, or when its host sends it back): it still replaces what it did.
    if (candidate && candidate === unverified?.session && replaced === undefined) {
      replaced = unverified.replaced;
    }

    // Only a request with the session pp-dev holds says it ended: one sent with an older session
    // and answered late says nothing about the current one. Ended first, even if MI also hands out
    // a new session here: that one may not be checked for a while.
    if (user.state === 'active' && isLoggedOutResponse(res) && requestSession === user.session) {
      this.#expire(user, `MI turned away ${req.method} ${req.url}`);
    }

    if (
      candidate &&
      candidate !== user.session &&
      candidate !== this.#checking.get(user) &&
      candidate !== this.#guestSessions.get(user) &&
      !this.#isLeftBehind(user, candidate)
    ) {
      return this.#verify(user, candidate, replaced, ownHost);
    }

    return undefined;
  }

  async #verify(user: SavedUser, session: string, replaced: string | undefined, ownHost: boolean): Promise<void> {
    this.#checking.set(user, session);

    let miUser: Awaited<ReturnType<SessionCheck>>;

    try {
      miUser = await this.#check(session);
    } catch (error) {
      // MI couldn't tell: neither a login nor a guest. A later response checks the session again.
      if (this.#checking.get(user) === session) {
        this.#checking.delete(user);
        this.#unverified.set(user, { session, replaced, ownHost, retryAt: Date.now() + RETRY_DELAY });
      }

      this.#logger.warn(colors.yellow(`Could not check the MI session of user ${user.name}: ${String(error)}`));

      return;
    }

    // A newer session came in meanwhile, the user expired, or it is gone.
    if (this.#checking.get(user) !== session || this.#users.get(user.name) !== user) {
      return;
    }

    this.#checking.delete(user);

    if (this.#unverified.get(user)?.session === session) {
      this.#unverified.delete(user);
    }

    if (miUser) {
      // A session the logged-in user already left behind, or MI's rotation of one. (Logged out, any
      // login is a new one, even from the browser still holding the session that ended.)
      if (this.#isLeftBehind(user, session) || (replaced !== undefined && this.#isLeftBehind(user, replaced))) {
        return;
      }

      const wasActive = user.state === 'active';

      if (ownHost) {
        this.#supersede(user);

        // The session the host's browser held until now, which may not be the one kept (MI rotated
        // that one on the main host).
        if (replaced !== undefined && replaced !== session) {
          this.#supersede(user, replaced);
        }
      }

      // A newer login replaces whatever session was still waiting for its check.
      this.#unverified.delete(user);

      Object.assign(user, { state: 'active', session, miUser });
      this.#guestSessions.delete(user);
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
      this.#guestSessions.set(user, session);

      // Ended only when MI handed the guest session out for the session pp-dev holds: a guest
      // verdict on another session (a late one, a stale cookie) says nothing about it.
      if (user.state === 'active' && replaced === user.session) {
        this.#expire(user, 'MI started a guest session');
      }
    }
  }

  /**
   * Whether `session` is one the logged-in `user` already left behind: a late request or answer
   * with it must not bring it back. Logged out, any session may be a new login.
   */
  #isLeftBehind(user: SavedUser, session: string): boolean {
    return user.state === 'active' && Boolean(this.#superseded.get(user)?.has(session));
  }

  /** Remembers `session` (by default the one `user` holds now) as one it left behind. */
  #supersede(user: SavedUser, session = user.session): void {
    if (!session) {
      return;
    }

    const superseded = this.#superseded.get(user) ?? new Set<string>();

    superseded.add(session);

    // A handful is plenty: only requests still in flight can bring one back.
    if (superseded.size > MAX_SUPERSEDED) {
      superseded.delete(superseded.values().next().value as string);
    }

    this.#superseded.set(user, superseded);
  }

  #expire(user: SavedUser, reason: string): void {
    this.#supersede(user);
    user.state = 'expired';
    user.session = undefined;
    // A check still running, or waiting, for an earlier session must not bring the user back.
    this.#checking.delete(user);
    this.#unverified.delete(user);
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
