import type { Application, Request, Response } from 'express';
import { MiAPI } from './pp.middleware.js';
import { SavedUser, UserRegistry, getUserNameError, userRegistry } from './user-registry.js';
import { getTokenErrorInfo, isSecureRequest } from './helpers/index.js';
import { createLogger } from './logger.js';
import { colors } from './helpers/color.helper.js';

/** Saved users (PP-4592): `GET` lists them, `POST` adds one by API token, `DELETE /:name` removes one. */
export const USERS_API_PATH = '/@api/users';

interface UserRoutesDeps {
  miAPI: MiAPI;
  users?: UserRegistry;
}

const routeStates = new WeakMap<Application, { deps: UserRoutesDeps }>();

/** What the browser gets to see of a saved user: never its token. */
export interface PublicUser {
  name: string;
  kind: SavedUser['kind'];
  miUser?: SavedUser['miUser'];
  /** Where the user's pages open: `http://<name>.localhost:<port>`. */
  origin: string;
}

/** The origin of `name`'s host, on the scheme and port `req` came in on. */
export function getUserOrigin(name: string, req: Request): string {
  const port = /:(\d+)$/.exec(req.headers.host ?? '')?.[1];

  return `${isSecureRequest(req) ? 'https' : 'http'}://${name}.localhost${port ? `:${port}` : ''}`;
}

function toPublicUser(user: SavedUser, req: Request): PublicUser {
  return { name: user.name, kind: user.kind, miUser: user.miUser, origin: getUserOrigin(user.name, req) };
}

function sendError(res: Response, status: number, code: string, error: string) {
  res.status(status).json({ error, code });
}

export function registerUserRoutes(app: Application, deps: UserRoutesDeps): void {
  const existing = routeStates.get(app);

  if (existing) {
    existing.deps = deps;

    return;
  }

  const current = { deps };

  routeStates.set(app, current);

  const logger = createLogger();
  const getUsers = () => current.deps.users ?? userRegistry;

  app.get(USERS_API_PATH, (req, res) => {
    const users = getUsers();

    res.json({
      users: users.list().map((user) => toPublicUser(user, req)),
      defaultUser: users.defaultUser?.name ?? null,
    });
  });

  app.post(USERS_API_PATH, async (req, res) => {
    const { miAPI } = current.deps;
    const users = getUsers();
    const body = (req.body ?? {}) as { name?: unknown; token?: unknown };
    const name = typeof body.name === 'string' ? body.name : '';
    const token = typeof body.token === 'string' ? body.token.trim() : '';

    // The dev panel always works as the original user, which multi-user mode needs a token for.
    if (!miAPI.personalAccessToken) {
      sendError(
        res,
        409,
        'ORIGINAL_TOKEN_REQUIRED',
        'Adding users needs your own API token: set mi.token or MI_ACCESS_TOKEN.',
      );

      return;
    }

    const nameError = getUserNameError(name);

    if (nameError) {
      sendError(res, 400, 'INVALID_NAME', nameError);

      return;
    }

    if (users.get(name)) {
      sendError(res, 409, 'NAME_TAKEN', `A user named "${name}" already exists`);

      return;
    }

    if (!token) {
      sendError(res, 400, 'TOKEN_REQUIRED', 'The API token is required');

      return;
    }

    let miUser: { id: number; username: string };

    try {
      const response = await miAPI.get<{ user?: { user_id?: unknown; username?: unknown } }>(
        '/data/page/index/auth/info',
        { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
        true,
      );
      const user = response.data?.user;

      if (typeof user?.user_id !== 'number') {
        sendError(res, 400, 'INVALID_TOKEN', 'The API token is expired or invalid');

        return;
      }

      miUser = { id: user.user_id, username: typeof user.username === 'string' ? user.username : '' };
    } catch (error) {
      const { status, userFriendlyMessage } = getTokenErrorInfo(error);

      if (status === 401 || status === 403 || status === 412) {
        sendError(res, 400, 'INVALID_TOKEN', `The API token was rejected: ${userFriendlyMessage}`);
      } else {
        sendError(res, 502, 'MI_UNAVAILABLE', `Could not check the API token with MI: ${userFriendlyMessage}`);
      }

      return;
    }

    let saved: SavedUser;

    try {
      // The name may have been taken while the token was being checked.
      saved = users.add({ name, kind: 'token', token, miUser });
    } catch (error) {
      sendError(res, 409, 'NAME_TAKEN', error instanceof Error ? error.message : String(error));

      return;
    }

    logger.info(
      `${colors.blue('Added user')} ${colors.yellow(saved.name)} (MI user ${miUser.id}${
        miUser.username ? `, ${miUser.username}` : ''
      }) at ${getUserOrigin(saved.name, req)}`,
    );

    res.status(201).json({ user: toPublicUser(saved, req) });
  });

  app.delete(`${USERS_API_PATH}/:name`, (req, res) => {
    const name = String(req.params.name);

    if (!getUsers().remove(name)) {
      sendError(res, 404, 'NOT_FOUND', `There is no user named "${name}"`);

      return;
    }

    logger.info(`${colors.blue('Removed user')} ${colors.yellow(name)}`);

    res.status(204).end();
  });
}
