import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  SessionUserTracker,
  withSessionCookie,
  withoutSessionSetCookie,
  type SessionCheck,
} from '../../../src/lib/session-users.js';
import { UserRegistry, type SavedUser } from '../../../src/lib/user-registry.js';

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

  it('does not check a session again that the request already carried', async () => {
    await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), setsSession('S1'));

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
      tracker.observe(qa, req('localhost:3000'), { statusCode: 401, headers: {} });

      expect(users.defaultUser).toBeUndefined();
    });

    it('becomes active again after logging in again', async () => {
      tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=S1'), { statusCode: 401, headers: {} });
      loggedIn.S2 = { id: 7, username: 'qa@example.com' };

      await tracker.observe(qa, req('qa.localhost:3000', 'metric_insights_session=GUEST'), setsSession('S2'));

      expect(qa).toMatchObject({ state: 'active', session: 'S2' });
    });
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
});

describe('session cookie helpers', () => {
  it('sets the MI session in a Cookie header, keeping the other cookies', () => {
    expect(withSessionCookie('theme=dark; metric_insights_session=MAIN; lang=en', 'S1')).toBe(
      'theme=dark; lang=en; metric_insights_session=S1',
    );
    expect(withSessionCookie(undefined, 'S1')).toBe('metric_insights_session=S1');
  });

  it('drops the MI session from Set-Cookie headers', () => {
    expect(withoutSessionSetCookie(['metric_insights_session=S2; path=/', 'theme=dark; path=/'])).toEqual([
      'theme=dark; path=/',
    ]);
    expect(withoutSessionSetCookie(['metric_insights_session=S2; path=/'])).toBeUndefined();
    expect(withoutSessionSetCookie(undefined)).toBeUndefined();
  });
});
