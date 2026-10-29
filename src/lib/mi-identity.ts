/**
 * Who MI says a set of credentials belongs to: an API token (token users) or an MI session (session
 * users). One check for both, which the users' HTTP routes, the session tracker and the token store
 * share; it used to be written twice, and the store imported it from the HTTP routes.
 */
import type { MiAPI } from './pp.middleware.js';
import { getTokenErrorInfo, isTokenError } from './helpers/token.helper.js';
import { MI_SESSION_COOKIE } from './helpers/cookie.helper.js';

export interface MiUser {
  id: number;
  username: string;
}

/**
 * MI's answer: the user, or none (a guest, or credentials it refused, with why it refused them).
 * Throws when MI can't tell (down, timing out, a server error): that says nothing about them.
 */
export type WhoIs = { miUser: MiUser } | { miUser: undefined; refused?: string };

/** Asks MI whose credentials `headers` carry (`Authorization` or a session `Cookie`). */
export async function whoIs(miAPI: MiAPI, headers: Record<string, string>): Promise<WhoIs> {
  try {
    const response = await miAPI.get<{ user?: { user_id?: unknown; username?: unknown } }>(
      '/data/page/index/auth/info',
      { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      true,
      // A refusal is an answer here, not a failure of the developer's own token.
      { quiet: true },
    );
    const user = response.data?.user;

    return typeof user?.user_id === 'number'
      ? { miUser: { id: user.user_id, username: typeof user.username === 'string' ? user.username : '' } }
      : { miUser: undefined };
  } catch (error) {
    if (isTokenError(error)) {
      return { miUser: undefined, refused: getTokenErrorInfo(error).userFriendlyMessage };
    }

    throw error;
  }
}

export type TokenCheck =
  | { ok: true; miUser: MiUser }
  /** `rejected`: MI turned the token down; otherwise MI couldn't be asked. */
  | { ok: false; rejected: boolean; message: string };

/** Asks MI who an API token belongs to. */
export async function checkUserToken(miAPI: MiAPI, token: string): Promise<TokenCheck> {
  try {
    const answer = await whoIs(miAPI, { Authorization: `Bearer ${token}` });

    if (answer.miUser) {
      return { ok: true, miUser: answer.miUser };
    }

    return {
      ok: false,
      rejected: true,
      message: answer.refused ? `The API token was rejected: ${answer.refused}` : 'The API token is expired or invalid',
    };
  } catch (error) {
    return {
      ok: false,
      rejected: false,
      message: `Could not check the API token with MI: ${getTokenErrorInfo(error).userFriendlyMessage}`,
    };
  }
}

/**
 * The MI user an MI session belongs to, or `undefined` for a guest (not logged in) session. Throws
 * when MI can't tell (down, timing out, a server error): that says nothing about the session.
 */
export type SessionCheck = (session: string) => Promise<MiUser | undefined>;

/** Asks MI who a session belongs to, the way the API token check does for tokens. */
export function createSessionCheck(miAPI: MiAPI): SessionCheck {
  return async (session) => (await whoIs(miAPI, { Cookie: `${MI_SESSION_COOKIE}=${session}` })).miUser;
}
