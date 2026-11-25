/**
 * The original user from a username + password login (PP-4602).
 *
 * The dev panel always works as the original user, whatever host its tab is on. With an API token
 * (`mi.token`, `MI_ACCESS_TOKEN` or the token login) that token is the original user. Without one, it
 * is whoever is logged in to MI on the main host (`localhost`): the proxy follows the MI session of
 * the main host's cookies and sends the dev panel's MI calls with it, from any host. A login on
 * `localhost` as another MI user makes that user the original one: the main host has one cookie jar.
 *
 * The session is kept in memory only, never written to disk or logged, and never sent to a browser.
 */
import type { IncomingMessage } from 'node:http';
import type { MiUser, SessionCheck } from './mi-identity.js';
import { type ObservedResponse, isLoggedOutResponse } from './session-users.js';
import { MI_SESSION_COOKIE, getRequestCookie, getSetCookieValue } from './helpers/cookie.helper.js';
import { createLogger } from './logger.js';
import { colors } from './helpers/color.helper.js';

/** How long a session check MI couldn't answer waits before it is tried again. */
const RETRY_DELAY = 5000;

/** How many sessions the login left behind are remembered. */
const MAX_SUPERSEDED = 20;

/**
 * `none` until someone logs in on the main host, `active` while that MI session lasts, `expired`
 * once MI ends it (log in again on the main host).
 */
export type OriginalSessionState = 'none' | 'active' | 'expired';

export class OriginalSession {
  #state: OriginalSessionState = 'none';

  #session: string | undefined;

  #miUser: MiUser | undefined;

  #check: SessionCheck | undefined;

  /** The session the latest check is about, so an older answer can't win. */
  #checking: string | undefined;

  /** The last session MI said is a guest one, so it isn't checked over and over. */
  #guest: string | undefined;

  /**
   * A session MI handed out whose check couldn't be answered, checked again on a later response.
   * Keeps the session it replaced, so a guest verdict that comes later still ends that one.
   */
  #unverified: { session: string; replaced?: string; retryAt: number } | undefined;

  /** Bumped by {@link clear}: a check started before must not bring the old session back. */
  #generation = 0;

  /**
   * Sessions the login left behind: replaced by a newer one (another login, MI rotating it) or
   * ended. While a login is active, a request still sent with one of them (answered late) and a
   * session MI hands out in place of one belong to the older login: they must not bring it back.
   */
  readonly #superseded = new Set<string>();

  readonly #changeListeners = new Set<() => void>();

  readonly #logger = createLogger();

  /**
   * Runs `listener` when the original user's login starts, turns into another MI user's or ends, so
   * what is cached for the old one can be dropped. Returns an unsubscribe function.
   */
  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);

    return () => {
      this.#changeListeners.delete(listener);
    };
  }

  /** Whether `req` was sent with a session the active login already left behind. */
  isLeftBehindRequest(req: Pick<IncomingMessage, 'headers'>): boolean {
    const session = getRequestCookie(req.headers.cookie, MI_SESSION_COOKIE);

    return session !== undefined && this.#isLeftBehind(session);
  }

  /**
   * Whether `session` is one the login on localhost left behind, active or not: headers stored from
   * an earlier page load may still carry it once the login ended.
   */
  hasLeft(session: string): boolean {
    return this.#superseded.has(session);
  }

  /** How sessions are checked with MI: the dev server's own MiAPI. */
  useCheck(check: SessionCheck): void {
    this.#check = check;
  }

  get state(): OriginalSessionState {
    return this.#state;
  }

  /** The MI user logged in on the main host; kept once the session ends, to say who to log in as. */
  get miUser(): MiUser | undefined {
    return this.#miUser;
  }

  /** The MI session the dev panel's calls go with, while it lasts. */
  get session(): string | undefined {
    return this.#state === 'active' ? this.#session : undefined;
  }

  /** Forgets the session: the dev server switched to another MI instance, whose sessions differ. */
  clear(): void {
    this.#generation += 1;
    this.#state = 'none';
    this.#session = undefined;
    this.#miUser = undefined;
    this.#checking = undefined;
    this.#guest = undefined;
    this.#unverified = undefined;
    this.#superseded.clear();
  }

  /**
   * Looks at the response to a request the main host sent MI as the original user, with no API
   * token. A session the main host carries or MI hands it out that isn't the one kept is checked
   * with MI: one of an MI user is a login; MI turning away a request with the kept session, or a
   * guest session in its place, means it ended. Returns the pending check, if this response started
   * one (tests wait for it; the proxy doesn't).
   */
  observe(req: Pick<IncomingMessage, 'headers' | 'method' | 'url'>, res: ObservedResponse): Promise<void> | undefined {
    const requestSession = getRequestCookie(req.headers.cookie, MI_SESSION_COOKIE);
    const newSession = getSetCookieValue(res.headers['set-cookie'], MI_SESSION_COOKIE);
    const loggedOut = isLoggedOutResponse(res);
    // A request sent with a session the login left behind, answered late: what MI says of it, or
    // hands out for it, belongs to that older login.
    const leftBehind = requestSession !== undefined && this.#isLeftBehind(requestSession);
    let candidate: string | undefined;
    // The session MI replaced with `candidate`, when it handed one out in this response.
    let replaced: string | undefined;

    if (newSession && newSession !== requestSession) {
      if (!leftBehind) {
        candidate = newSession;
        replaced = requestSession;
      }
    } else if (requestSession && requestSession !== this.#session && !loggedOut && !leftBehind) {
      // The main host carries a session pp-dev hasn't recognized: one from before a dev server
      // restart, or set by a login that didn't go through the proxy (the regular token login).
      candidate = requestSession;
    } else if (this.#unverified && Date.now() >= this.#unverified.retryAt) {
      candidate = this.#unverified.session;
      replaced = this.#unverified.replaced;
    }

    // Only a request with the session kept says it ended: one sent with an older session says
    // nothing about it.
    if (this.#state === 'active' && loggedOut && requestSession === this.#session) {
      this.#expire(`MI turned away ${req.method} ${req.url}`);
    }

    if (
      candidate &&
      candidate !== this.#session &&
      candidate !== this.#checking &&
      candidate !== this.#guest &&
      !this.#isLeftBehind(candidate)
    ) {
      return this.#verify(candidate, replaced);
    }

    return undefined;
  }

  /**
   * A logout on the main host ends the session at once, before MI's answer is checked. Not logged
   * in yet (or any more), it drops a check still running or waiting for the session logged out: its
   * late answer must not make that dead session the login.
   */
  loggedOut(): void {
    if (this.#state === 'active') {
      this.#expire('logged out on localhost');

      return;
    }

    this.#checking = undefined;
    this.#unverified = undefined;
  }

  /**
   * MI refused a dev panel call sent with `session` (a 401 or 412). That can be the session ending,
   * or only a page the user may not see: MI is asked which.
   */
  recheck(session: string | undefined): Promise<void> | undefined {
    if (this.#state !== 'active' || !session || session !== this.#session || this.#checking === session) {
      return undefined;
    }

    // Checked as if MI had replaced the kept session with itself: a guest verdict ends it.
    return this.#verify(session, session);
  }

  async #verify(session: string, replaced: string | undefined): Promise<void> {
    const check = this.#check;

    if (!check) {
      return;
    }

    const generation = this.#generation;

    this.#checking = session;

    let miUser: MiUser | undefined;

    try {
      miUser = await check(session);
    } catch (error) {
      // MI couldn't tell: neither a login nor a guest. A later response checks the session again.
      if (this.#generation === generation && this.#checking === session) {
        this.#checking = undefined;
        this.#unverified = { session, replaced, retryAt: Date.now() + RETRY_DELAY };
      }

      this.#logger.warn(colors.yellow(`Could not check your MI session on localhost: ${String(error)}`));

      return;
    }

    // A newer session came in meanwhile, or the dev server switched to another MI.
    if (this.#generation !== generation || this.#checking !== session) {
      return;
    }

    this.#checking = undefined;

    if (this.#unverified?.session === session) {
      this.#unverified = undefined;
    }

    if (miUser) {
      // A session the active login already left behind, or MI's rotation of one, checked while
      // a newer one came in. (Logged out, any login is a new one.)
      if (this.#isLeftBehind(session) || (replaced !== undefined && this.#isLeftBehind(replaced))) {
        return;
      }

      const wasActive = this.#state === 'active';
      const previous = this.#miUser;

      // The session this one replaces, and the one the main host held until now, are left behind.
      if (wasActive && this.#session !== session) {
        this.#supersede(this.#session);
      }

      if (replaced !== undefined && replaced !== session) {
        this.#supersede(replaced);
      }

      // A newer login replaces whatever session was still waiting for its check.
      this.#unverified = undefined;
      this.#guest = undefined;
      this.#state = 'active';
      this.#session = session;
      this.#miUser = miUser;

      if (!wasActive || previous?.id !== miUser.id) {
        this.#logger.info(
          `${colors.blue('Logged in on localhost')} as MI user ${miUser.id}${
            miUser.username ? ` (${miUser.username})` : ''
          }: the dev panel works as this user`,
        );
        // What was cached belongs to nobody (a guest) or to another MI user.
        this.#notifyChange();
      }
    } else {
      this.#guest = session;

      // Ended only when MI handed the guest session out for the session kept: a guest verdict on
      // another session (a late one, a stale cookie) says nothing about it.
      if (this.#state === 'active' && replaced === this.#session) {
        this.#expire('MI started a guest session');
      }
    }
  }

  #expire(reason: string): void {
    this.#supersede(this.#session);
    this.#state = 'expired';
    this.#session = undefined;
    // A check still running, or waiting, for an earlier session must not bring it back.
    this.#checking = undefined;
    this.#unverified = undefined;

    this.#logger.warn(
      `${colors.yellow('Your MI session on localhost ended')} (${reason}). ` +
        'Log in again on localhost: the dev panel works as you.',
    );

    // The page data and responses cached for the login must not outlive it, though no new session
    // reached the browser (an ended login noticed through a dev panel call).
    this.#notifyChange();
  }

  /** Whether `session` is one the active login left behind. Logged out, any login is a new one. */
  #isLeftBehind(session: string): boolean {
    return this.#state === 'active' && this.#superseded.has(session);
  }

  #supersede(session: string | undefined): void {
    if (!session) {
      return;
    }

    this.#superseded.add(session);

    // A handful is plenty: only requests still in flight, or headers kept from a page load, bring one back.
    if (this.#superseded.size > MAX_SUPERSEDED) {
      this.#superseded.delete(this.#superseded.values().next().value as string);
    }
  }

  #notifyChange(): void {
    this.#changeListeners.forEach((listener) => listener());
  }
}

/** The original user's session of this dev server process. */
export const originalSession = new OriginalSession();
