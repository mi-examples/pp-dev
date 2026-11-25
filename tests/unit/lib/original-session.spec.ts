import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OriginalSession } from '../../../src/lib/original-session.js';
import type { MiUser } from '../../../src/lib/mi-identity.js';

/**
 * PP-4602: without an API token, the original user (the one the dev panel works as) is whoever is
 * logged in to MI on the main host. The proxy follows that host's MI session through MI's answers.
 */

const DEV: MiUser = { id: 7, username: 'dev' };
const ADMIN: MiUser = { id: 1, username: 'admin' };

/** A main-host request that carries `session` in its cookies. */
function request(session?: string, url = '/home') {
  return {
    method: 'GET',
    url,
    headers: session ? { cookie: `theme=dark; metric_insights_session=${session}` } : {},
  };
}

function response(statusCode = 200, setSession?: string, location?: string) {
  return {
    statusCode,
    headers: {
      ...(setSession ? { 'set-cookie': [`metric_insights_session=${setSession}; path=/; httponly`] } : {}),
      ...(location ? { location } : {}),
    },
  };
}

describe('OriginalSession', () => {
  let original: OriginalSession;
  /** MI sessions that belong to an MI user; any other is a guest one. */
  let owners: Map<string, MiUser>;
  let check: ReturnType<typeof vi.fn<(session: string) => Promise<MiUser | undefined>>>;

  beforeEach(() => {
    owners = new Map([
      ['S1', DEV],
      ['S2', DEV],
      ['A1', ADMIN],
    ]);
    check = vi.fn(async (session: string) => owners.get(session));
    original = new OriginalSession();
    original.useCheck(check);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('knows nobody before a login', () => {
    expect(original.state).toBe('none');
    expect(original.session).toBeUndefined();
  });

  it('takes the session MI hands the main host on a login, once MI says whose it is', async () => {
    await original.observe(request('G1', '/login'), response(302, 'S1', '/home'));

    expect(check).toHaveBeenCalledWith('S1');
    expect(original.state).toBe('active');
    expect(original.session).toBe('S1');
    expect(original.miUser).toEqual(DEV);
  });

  it('takes a session the main host already carries (a login from before a dev server restart)', async () => {
    await original.observe(request('S1'), response());

    expect(original.session).toBe('S1');
  });

  it('never takes a guest session, and asks MI about it only once', async () => {
    await original.observe(request('G1'), response());
    expect(original.observe(request('G1'), response())).toBeUndefined();

    expect(original.state).toBe('none');
    expect(original.session).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('does not ask MI again about the session it keeps', async () => {
    await original.observe(request('S1'), response());

    expect(original.observe(request('S1'), response())).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('follows MI rotating the session', async () => {
    await original.observe(request('S1'), response());
    await original.observe(request('S1'), response(200, 'S2'));

    expect(original.session).toBe('S2');
  });

  it('follows a login on localhost as another MI user', async () => {
    await original.observe(request('S1'), response());
    await original.observe(request('G1', '/login'), response(302, 'A1'));

    expect(original.miUser).toEqual(ADMIN);
    expect(original.session).toBe('A1');
  });

  it('ends when MI turns away a request sent with the session it keeps', async () => {
    await original.observe(request('S1'), response());

    original.observe(request('S1', '/api/page'), response(302, undefined, 'https://mi.example.com/login'));

    expect(original.state).toBe('expired');
    expect(original.session).toBeUndefined();
    // Who to log in as again.
    expect(original.miUser).toEqual(DEV);
  });

  it.each([401, 412])('ends on a %i to a request with the session it keeps', async (status) => {
    await original.observe(request('S1'), response());

    original.observe(request('S1', '/api/page'), response(status));

    expect(original.state).toBe('expired');
  });

  it('does not end on a refused request sent with another session', async () => {
    await original.observe(request('S1'), response());

    original.observe(request('OLD', '/api/page'), response(401));

    expect(original.session).toBe('S1');
  });

  it('ends when MI hands out a guest session in place of the one it keeps', async () => {
    await original.observe(request('S1'), response());
    await original.observe(request('S1'), response(200, 'G2'));

    expect(original.state).toBe('expired');
  });

  it('does not end on a guest session that replaced another one', async () => {
    await original.observe(request('S1'), response());
    await original.observe(request('OLD'), response(200, 'G2'));

    expect(original.session).toBe('S1');
  });

  it('ends at once on a logout', async () => {
    await original.observe(request('S1'), response());

    original.loggedOut();

    expect(original.state).toBe('expired');
  });

  it('comes back with a new login after it ended', async () => {
    await original.observe(request('S1'), response());
    original.loggedOut();
    await original.observe(request('G1', '/login'), response(302, 'S2'));

    expect(original.state).toBe('active');
    expect(original.session).toBe('S2');
  });

  it('takes a check MI could not answer for no verdict, and asks again later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    check.mockRejectedValueOnce(new Error('MI is down'));

    await original.observe(request('G1', '/login'), response(302, 'S1'));
    expect(original.state).toBe('none');

    // Too soon: not asked again yet.
    expect(original.observe(request(), response())).toBeUndefined();

    vi.setSystemTime(Date.now() + 6000);
    await original.observe(request(), response());

    expect(original.session).toBe('S1');
  });

  it('lets the latest check win', async () => {
    let releaseOld!: () => void;

    check.mockImplementationOnce(
      (session) => new Promise((resolve) => (releaseOld = () => resolve(owners.get(session)))),
    );

    const old = original.observe(request('S1'), response());
    await original.observe(request('A1'), response());

    releaseOld();
    await old;

    expect(original.session).toBe('A1');
  });

  it('forgets everything on clear, a check still running included', async () => {
    let release!: () => void;

    check.mockImplementationOnce((session) => new Promise((resolve) => (release = () => resolve(owners.get(session)))));

    const pending = original.observe(request('S1'), response());

    original.clear();
    release();
    await pending;

    expect(original.state).toBe('none');
    expect(original.session).toBeUndefined();
  });

  describe('recheck after MI refused a dev panel call', () => {
    beforeEach(async () => {
      await original.observe(request('S1'), response());
      check.mockClear();
    });

    it('ends the session when MI says it is a guest one now', async () => {
      owners.delete('S1');

      await original.recheck('S1');

      expect(original.state).toBe('expired');
    });

    it('keeps the session when MI still knows its user (a page the user may not see)', async () => {
      await original.recheck('S1');

      expect(check).toHaveBeenCalledWith('S1');
      expect(original.session).toBe('S1');
    });

    it('ignores a call sent with another session, or none', () => {
      expect(original.recheck('OTHER')).toBeUndefined();
      expect(original.recheck(undefined)).toBeUndefined();
      expect(check).not.toHaveBeenCalled();
    });
  });
});
