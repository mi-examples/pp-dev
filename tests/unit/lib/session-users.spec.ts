import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  SessionUserTracker,
  withSessionCookie,
  withoutSessionCookie,
  withoutSessionSetCookie,
} from '../../../src/lib/session-users.js';
import { createSessionCheck, type SessionCheck } from '../../../src/lib/mi-identity.js';
import { UserRegistry, type SavedUser } from '../../../src/lib/user-registry.js';
import type { MiAPI } from '../../../src/lib/pp.middleware.js';

/**
 * PP-4596: a session user logs in through MI's login page on its own host. pp-dev learns about the
 * login, and about the session ending, from the responses MI sends to that host.
 */

const req = (host: string, cookie?: string, url = '/api/user') =>
  ({ method: 'GET', url, headers: { host, ...(cookie ? { cookie } : {}) } }) as unknown as IncomingMessage;

const setsSession = (session: string) => ({
  statusCode: 200,
  headers: { 'set-cookie': [`metric_insights_session=${session}; path=/; httponly`] },
});

const ok = { statusCode: 200, headers: {} };

describe('SessionUserTracker', () => {
  let users: UserRegistry;
  let check: ReturnType<typeof vi.fn<SessionCheck>>;
  let tracker: SessionUserTracker;
  let qa: SavedUser;

  /** Sessions that belong to an MI user; any other is a guest session. */
  const loggedIn: Record<string, { id: number; username: string }> = { S1: { id: 7, username: 'qa@example.com' } };

  beforeEach(() => {
    users = new UserRegistry();
    check = vi.fn<SessionCheck>(async (session) => loggedIn[session]);
    tracker = new SessionUserTracker(users, check);
    qa = users.add({ name: 'qa', kind: 'session' });
  });

  it('keeps a user pending while its host only gets guest sessions', async () => {
    await tracker.observe(qa, req('qa.localhost:3000'), setsSession('GUEST'));

    expect(check).toHaveBeenCalledWith('GUEST');
    expect(qa.state).toBe('pending');
    expect(qa.session).toBeUndefined();
  });

  it('marks a user active once its host gets a session of an MI user', async () => {
    await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=GUEST'), setsSession('S1'));

    expect(qa).toMatchObject({ state: 'active', session: 'S1', miUser: { id: 7, username: 'qa@example.com' } });
  });

  it('checks the session its host already carries while it is not logged in, once', async () => {
    // Cookies outlive a dev server restart or removing the user: MI may keep the session and set none.
    await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), ok);

    expect(check).toHaveBeenCalledWith('S1');
    expect(qa).toMatchObject({ state: 'active', session: 'S1' });

    await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), ok);

    expect(check).toHaveBeenCalledTimes(1);
  });

  it('checks a guest session its host carries only once', async () => {
    await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=GUEST'), ok);
    await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=GUEST'), ok);
    await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=GUEST'), setsSession('GUEST'));

    expect(check).toHaveBeenCalledTimes(1);
    expect(qa.state).toBe('pending');
  });

  it('leaves alone a user removed, or removed and added again, while the request was in flight', () => {
    users.remove('qa');
    users.add({ name: 'qa', kind: 'session' });

    expect(tracker.observe(qa, req('qa.localhost:3000'), setsSession('S1'))).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it('tells the registry when the session starts and ends, so the cache can go', async () => {
    const changed = vi.fn();

    users.onSessionChange(changed);
    await tracker.observe(qa, req('qa.localhost:3000'), setsSession('S1'));
    tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), { statusCode: 401, headers: {} });

    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('compares with the session the proxy sent from the main host, not the one kept now', async () => {
    Object.assign(qa, { state: 'active', session: 'S1' });

    // The request went with S1; MI answers it with S1 again: nothing new, nothing to check.
    await tracker.observe(qa, req('localhost:3000'), setsSession('S1'), 'S1');

    expect(check).not.toHaveBeenCalled();
  });

  it('ignores token users', () => {
    const viewer = users.add({ name: 'viewer', kind: 'token', token: 't' });

    expect(tracker.observe(viewer, req('viewer.localhost:3000'), setsSession('S1'))).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  describe('once logged in', () => {
    beforeEach(async () => {
      await tracker.observe(qa, req('qa.localhost:3000'), setsSession('S1'));
    });

    it.each([
      ['a redirect to the login page', { statusCode: 302, headers: { location: '/login?redirect=%2Fhome' } }],
      [
        'a redirect to the SAML login',
        { statusCode: 302, headers: { location: 'https://mi.example.com/auth/saml/login' } },
      ],
      ['a 401', { statusCode: 401, headers: {} }],
      ['a 412 (an expired MI session)', { statusCode: 412, headers: {} }],
    ])('marks it expired on %s', (_, response) => {
      tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), response);

      expect(qa).toMatchObject({ state: 'expired', session: undefined });
    });

    it('marks it expired when MI hands its host a guest session', async () => {
      await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), setsSession('GUEST'));

      expect(qa.state).toBe('expired');
    });

    it('stays active on ordinary responses and on redirects elsewhere', () => {
      tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), ok);
      tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), {
        statusCode: 302,
        headers: { location: '/home' },
      });

      expect(qa.state).toBe('active');
    });

    it('sends the main host back to the original user when the default user expires', () => {
      users.setDefaultUser('qa');
      tracker.observe(qa, req('localhost:3000'), { statusCode: 401, headers: {} }, 'S1');

      expect(users.defaultUser).toBeUndefined();
    });

    it('stays active when a request sent with an older session is turned away late', () => {
      tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S0'), { statusCode: 401, headers: {} });
      tracker.observe(qa, req('localhost:3000'), { statusCode: 412, headers: {} }, 'S0');

      expect(qa).toMatchObject({ state: 'active', session: 'S1' });
    });

    it('stays active when MI answers a request sent with an older session with a guest session', async () => {
      await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S0'), setsSession('GUEST'));

      expect(check).toHaveBeenCalledWith('GUEST');
      expect(qa).toMatchObject({ state: 'active', session: 'S1' });
    });

    it('stays active when its host carries a stale guest session', async () => {
      await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=OLDGUEST'), ok);

      expect(check).toHaveBeenCalledWith('OLDGUEST');
      expect(qa).toMatchObject({ state: 'active', session: 'S1' });
    });

    it('becomes active again after logging in again', async () => {
      tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), { statusCode: 401, headers: {} });
      loggedIn.S2 = { id: 7, username: 'qa@example.com' };

      await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=GUEST'), setsSession('S2'));

      expect(qa).toMatchObject({ state: 'active', session: 'S2' });
    });
  });

  it('does not bring a user back with a check that was running when its session ended', async () => {
    await tracker.observe(qa, req('qa.localhost:3000'), setsSession('S1'));

    let release!: () => void;

    loggedIn.S3 = { id: 7, username: 'qa@example.com' };
    check.mockImplementationOnce((session) => new Promise((resolve) => (release = () => resolve(loggedIn[session]))));

    const pending = tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), setsSession('S3'));

    tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), { statusCode: 401, headers: {} });
    release();
    await pending;

    expect(qa).toMatchObject({ state: 'expired', session: undefined });
  });

  it('checks a session again after MI could not tell, instead of taking it for a guest', async () => {
    check.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), ok);

    expect(qa.state).toBe('pending');

    await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), ok);

    expect(check).toHaveBeenCalledTimes(2);
    expect(qa).toMatchObject({ state: 'active', session: 'S1' });
  });

  it('keeps a logged-in user active when MI could not tell about a new session', async () => {
    await tracker.observe(qa, req('qa.localhost:3000'), setsSession('S1'));
    check.mockRejectedValueOnce(new Error('timeout of 30000ms exceeded'));

    await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), setsSession('S9'));

    expect(qa).toMatchObject({ state: 'active', session: 'S1' });
  });

  it('picks up a rotated session whose check failed once the host sends it again', async () => {
    await tracker.observe(qa, req('qa.localhost:3000'), setsSession('S1'));

    // MI rotates S1 to S2, and the check of S2 can't be answered.
    loggedIn.S2 = { id: 7, username: 'qa@example.com' };
    check.mockRejectedValueOnce(new Error('timeout of 30000ms exceeded'));
    await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), setsSession('S2'));

    expect(qa.session).toBe('S1');

    // The browser keeps S2 and sends it; MI sets no cookie this time.
    await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S2'), ok);

    expect(qa).toMatchObject({ state: 'active', session: 'S2' });
  });

  it('does not let a late rotation of an older session replace a newer login', async () => {
    await tracker.observe(qa, req('qa.localhost:3000'), setsSession('S1'));
    users.setDefaultUser('qa');

    // The user logs in again on its host (S2) while a main-host request sent with S1 is out.
    loggedIn.S2 = { id: 8, username: 'admin@example.com' };
    await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), setsSession('S2'));

    expect(qa).toMatchObject({ state: 'active', session: 'S2' });

    // MI answers the old request with S3, a rotation of S1.
    loggedIn.S3 = { id: 7, username: 'qa@example.com' };
    await tracker.observe(qa, req('localhost:3000'), setsSession('S3'), 'S1');

    expect(qa).toMatchObject({ state: 'active', session: 'S2', miUser: { id: 8 } });
  });

  it('does not go back to an older session its host sent before a newer login', async () => {
    await tracker.observe(qa, req('qa.localhost:3000'), setsSession('S1'));
    loggedIn.S2 = { id: 8, username: 'admin@example.com' };
    await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), setsSession('S2'));

    // A request sent with S1 before the login comes back late, without a new cookie.
    await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), ok);

    expect(check).toHaveBeenCalledTimes(2);
    expect(qa).toMatchObject({ state: 'active', session: 'S2', miUser: { id: 8 } });
  });

  it('ends the session MI turned away even when the new session it hands out cannot be checked', async () => {
    await tracker.observe(qa, req('qa.localhost:3000'), setsSession('S1'));
    users.setDefaultUser('qa');
    check.mockRejectedValueOnce(new Error('timeout of 30000ms exceeded'));

    await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), {
      statusCode: 401,
      headers: { 'set-cookie': ['metric_insights_session=GUEST; path=/'] },
    });

    expect(qa).toMatchObject({ state: 'expired', session: undefined });
    expect(users.defaultUser).toBeUndefined();
  });

  it('takes a login on its host after MI rotated the session on the main host', async () => {
    await tracker.observe(qa, req('qa.localhost:3000'), setsSession('S1'));
    users.setDefaultUser('qa');

    // The main host's request rotates S1 to S2; the cookie never reaches the user's host.
    loggedIn.S2 = { id: 7, username: 'qa@example.com' };
    await tracker.observe(qa, req('localhost:3000'), setsSession('S2'), 'S1');

    expect(qa.session).toBe('S2');

    // The user's host still holds S1, and logs in from it.
    const ownHost = req('qa.localhost:3000', 'metric_insights_session=S1');

    expect(tracker.isLeftBehindRequest(qa, ownHost)).toBe(false);

    loggedIn.S3 = { id: 8, username: 'admin@example.com' };
    await tracker.observe(qa, ownHost, setsSession('S3'));

    expect(qa).toMatchObject({ state: 'active', session: 'S3', miUser: { id: 8 } });

    // A request its host sent with S1 before that login comes back late with S4 (a rotation of S1).
    const late = req('qa.localhost:3000', 'metric_insights_session=S1');

    expect(tracker.isLeftBehindRequest(qa, late)).toBe(true);

    loggedIn.S4 = { id: 7, username: 'qa@example.com' };
    await tracker.observe(qa, late, setsSession('S4'));

    expect(qa).toMatchObject({ state: 'active', session: 'S3', miUser: { id: 8 } });
  });

  it('takes a login from a browser still holding the session that ended', async () => {
    await tracker.observe(qa, req('qa.localhost:3000'), setsSession('S1'));
    tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), { statusCode: 401, headers: {} });

    loggedIn.S2 = { id: 7, username: 'qa@example.com' };
    await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), setsSession('S2'));

    expect(qa).toMatchObject({ state: 'active', session: 'S2' });
  });

  describe('a guest session MI handed out for the active one, whose check failed', () => {
    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      await tracker.observe(qa, req('qa.localhost:3000'), setsSession('S1'));
      users.setDefaultUser('qa');
      check.mockRejectedValueOnce(new Error('timeout of 30000ms exceeded'));
      await tracker.observe(qa, req('localhost:3000'), setsSession('GUEST'), 'S1');
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('ends the session once a later check finds it a guest', async () => {
      expect(qa.state).toBe('active');

      vi.advanceTimersByTime(5000);
      await tracker.observe(qa, req('localhost:3000'), ok, 'S1');

      expect(qa).toMatchObject({ state: 'expired', session: undefined });
      expect(users.defaultUser).toBeUndefined();
    });

    it('ends the session when its host sends the guest session back', async () => {
      await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=GUEST'), ok);

      expect(qa).toMatchObject({ state: 'expired', session: undefined });
    });
  });

  describe('a session MI rotated to on the main host whose check failed', () => {
    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      await tracker.observe(qa, req('qa.localhost:3000'), setsSession('S1'));
      users.setDefaultUser('qa');
      loggedIn.S2 = { id: 7, username: 'qa@example.com' };
      check.mockRejectedValueOnce(new Error('timeout of 30000ms exceeded'));
      // The cookie never reaches a browser: the proxy keeps it from the main host.
      await tracker.observe(qa, req('localhost:3000'), setsSession('S2'), 'S1');
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('is checked again on a later response, once a short while has passed', async () => {
      await tracker.observe(qa, req('localhost:3000'), ok, 'S1');

      expect(check).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(5000);
      await tracker.observe(qa, req('localhost:3000'), ok, 'S1');

      expect(check).toHaveBeenCalledTimes(3);
      expect(check).toHaveBeenLastCalledWith('S2');
      expect(qa).toMatchObject({ state: 'active', session: 'S2' });
    });

    it('is not used before a check accepts it', () => {
      expect(qa.session).toBe('S1');
    });

    it('is dropped when the user logs in with another session', async () => {
      loggedIn.S3 = { id: 7, username: 'qa@example.com' };
      await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), setsSession('S3'));
      vi.advanceTimersByTime(5000);
      await tracker.observe(qa, req('localhost:3000'), ok, 'S3');

      expect(check.mock.calls.map(([session]) => session)).toEqual(['S1', 'S2', 'S3']);
      expect(qa.session).toBe('S3');
    });
  });

  it('does not check the session it already knows for a logged-in user', async () => {
    await tracker.observe(qa, req('qa.localhost:3000'), setsSession('S1'));
    await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), ok);

    expect(check).toHaveBeenCalledTimes(1);
  });

  it('lets the latest session win when checks overlap', async () => {
    let releaseFirst!: () => void;

    check.mockImplementationOnce(
      (session) => new Promise((resolve) => (releaseFirst = () => resolve(loggedIn[session]))),
    );

    const first = tracker.observe(qa, req('qa.localhost:3000'), setsSession('S1'));
    const second = tracker.observe(qa, req('qa.localhost:3000'), setsSession('GUEST'));

    await second;
    releaseFirst();
    await first;

    expect(qa.state).toBe('pending');
  });

  it('leaves a user removed during the check alone', async () => {
    const observing = tracker.observe(qa, req('qa.localhost:3000'), setsSession('S1'));

    users.remove('qa');
    await observing;

    expect(qa.state).toBe('pending');
  });

  it("checks a replacement registration's session although the old one's check was still running", async () => {
    let release!: () => void;

    check.mockImplementationOnce((session) => new Promise((resolve) => (release = () => resolve(loggedIn[session]))));

    const oldCheck = tracker.observe(qa, req('qa.localhost:3000'), setsSession('S1'));

    users.remove('qa');

    const replacement = users.add({ name: 'qa', kind: 'session' });

    release();
    await oldCheck;

    await tracker.observe(replacement, req('qa.localhost:3000', 'metric_insights_session=S1'), ok);

    expect(check).toHaveBeenCalledTimes(2);
    expect(replacement).toMatchObject({ state: 'active', session: 'S1' });
  });
});

describe('createSessionCheck', () => {
  const miAPI = (get: () => Promise<unknown>) => ({ get }) as unknown as MiAPI;
  const rejectWith = (status?: number) => () =>
    Promise.reject(Object.assign(new Error('failed'), status ? { response: { status, data: {} } } : {}));

  it('returns the MI user of a logged-in session', async () => {
    const check = createSessionCheck(miAPI(async () => ({ data: { user: { user_id: 7, username: 'qa' } } })));

    expect(await check('S1')).toEqual({ id: 7, username: 'qa' });
  });

  it.each([401, 403, 412])('takes a %s for a guest session', async (status) => {
    expect(await createSessionCheck(miAPI(rejectWith(status)))('S1')).toBeUndefined();
  });

  it.each([
    ['MI is down', undefined],
    ['a server error', 500],
  ])('throws when %s', async (_, status) => {
    await expect(createSessionCheck(miAPI(rejectWith(status)))('S1')).rejects.toThrow();
  });
});

describe('session cookie helpers', () => {
  it('sets the MI session in a Cookie header, keeping the other cookies', () => {
    expect(withSessionCookie('theme=dark; metric_insights_session=MAIN; lang=en', 'S1')).toBe(
      'theme=dark; lang=en; metric_insights_session=S1',
    );
    expect(withSessionCookie(undefined, 'S1')).toBe('metric_insights_session=S1');
  });

  it('drops the MI session from a Cookie header', () => {
    expect(withoutSessionCookie('theme=dark; metric_insights_session=MAIN; lang=en')).toBe('theme=dark; lang=en');
    expect(withoutSessionCookie('metric_insights_session=MAIN')).toBeUndefined();
  });

  it('drops the MI session from Set-Cookie headers', () => {
    expect(withoutSessionSetCookie(['metric_insights_session=S2; path=/', 'theme=dark; path=/'])).toEqual([
      'theme=dark; path=/',
    ]);
    expect(withoutSessionSetCookie(['metric_insights_session=S2; path=/'])).toBeUndefined();
    expect(withoutSessionSetCookie(undefined)).toBeUndefined();
  });
});
