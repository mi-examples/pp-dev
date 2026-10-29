import type { Application, Request, Response } from 'express';
import type { MiAPI } from './pp.middleware.js';
import { SavedUser, UserRegistry, getUserNameError, getUserOrigin, userRegistry } from './user-registry.js';
import { checkUserToken } from './mi-identity.js';
import { createLogger } from './logger.js';
import { colors } from './helpers/color.helper.js';

/**
 * Saved users (PP-4592): `GET` lists them, `POST` adds one (by API token, or a session user that
 * logs in on its own host), `DELETE /:name` removes one.
 */
export const USERS_API_PATH = '/@api/users';

interface UserRoutesDeps {
  miAPI: MiAPI;
  users?: UserRegistry;
}

const routeStates = new WeakMap<Application, { deps: UserRoutesDeps }>();

/** What the browser gets to see of a saved user: never its token or MI session. */
export interface PublicUser {
  name: string;
  kind: SavedUser['kind'];
  /** A session user's state: `pending` until it logs in, `active`, or `expired`. */
  state?: SavedUser['state'];
  miUser?: SavedUser['miUser'];
  /** Where the user's pages open: `http://<name>.localhost:<port>`. */
  origin: string;
  /** Where a session user logs in (again): MI's login page on its own host. */
  loginUrl?: string;
}

function toPublicUser(user: SavedUser, req: Request): PublicUser {
  const origin = getUserOrigin(req, user.name);

  return {
    name: user.name,
    kind: user.kind,
    ...(user.state ? { state: user.state } : {}),
    ...(user.kind === 'session' ? { loginUrl: `${origin}/login` } : {}),
    miUser: user.miUser,
    origin,
  };
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
      // Users can only be added with the original user's own token (the dev panel's user).
      available: Boolean(current.deps.miAPI.personalAccessToken),
      users: users.list().map((user) => toPublicUser(user, req)),
      defaultUser: users.defaultUser?.name ?? null,
    });
  });

  // `{ name }` makes a saved user the main host's default user; `{ name: null }` the original user again.
  app.put(`${USERS_API_PATH}/default`, (req, res) => {
    const users = getUsers();
    const name = (req.body ?? {}).name as unknown;

    if (name !== null && typeof name !== 'string') {
      sendError(res, 400, 'INVALID_NAME', 'name must be a user name or null');

      return;
    }

    if (name !== null && !users.get(name)) {
      sendError(res, 404, 'NOT_FOUND', `There is no user named "${name}"`);

      return;
    }

    try {
      users.setDefaultUser(name ?? undefined);
    } catch (error) {
      sendError(res, 409, 'NOT_LOGGED_IN', error instanceof Error ? error.message : String(error));

      return;
    }

    logger.info(`${colors.blue('Default user:')} ${colors.yellow(name ?? 'the original user')}`);

    res.json({ defaultUser: name });
  });

  app.post(USERS_API_PATH, async (req, res) => {
    const { miAPI } = current.deps;
    const users = getUsers();
    const body = (req.body ?? {}) as { name?: unknown; token?: unknown; kind?: unknown };
    const name = typeof body.name === 'string' ? body.name : '';
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const kind = body.kind ?? 'token';

    if (kind !== 'token' && kind !== 'session') {
      sendError(res, 400, 'INVALID_KIND', 'kind must be "token" or "session"');

      return;
    }

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

    // A session user logs in through MI's usual login page on its own host (loginUrl); pp-dev never
    // sees its password.
    if (kind === 'session') {
      const saved = users.add({ name, kind: 'session' });

      logger.info(
        `${colors.blue('Added user')} ${colors.yellow(saved.name)}: log in at ${getUserOrigin(req, saved.name)}/login`,
      );

      res.status(201).json({ user: toPublicUser(saved, req) });

      return;
    }

    if (!token) {
      sendError(res, 400, 'TOKEN_REQUIRED', 'The API token is required');

      return;
    }

    const contextAtStart = users.context;
    const check = await checkUserToken(miAPI, token);

    // The dev server restarted with another project or MI instance while the token was being
    // checked: the token belongs to the old one and must not be sent to the new one.
    if (users.context !== contextAtStart || current.deps.miAPI !== miAPI || getUsers() !== users) {
      sendError(res, 409, 'CONTEXT_CHANGED', 'The dev server switched to another MI instance; add the user again');

      return;
    }

    if (!check.ok) {
      if (check.rejected) {
        sendError(res, 400, 'INVALID_TOKEN', check.message);
      } else {
        sendError(res, 502, 'MI_UNAVAILABLE', check.message);
      }

      return;
    }

    const { miUser } = check;
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
      }) at ${getUserOrigin(req, saved.name)}`,
    );

    res.status(201).json({ user: toPublicUser(saved, req) });
  });

  // Edits a token user: `{ name }` renames it (its old host sends tabs on to the new one), `{ token }`
  // replaces its API token; a token left out or empty keeps the current one. A session user can't be
  // edited: its MI session lives in its host's cookies, which a new host doesn't get.
  app.patch(`${USERS_API_PATH}/:name`, async (req, res) => {
    const { miAPI } = current.deps;
    const users = getUsers();
    const name = String(req.params.name);
    const user = users.get(name);
    const body = (req.body ?? {}) as { name?: unknown; token?: unknown };
    const newName = typeof body.name === 'string' && body.name ? body.name : name;
    const token = typeof body.token === 'string' ? body.token.trim() : '';

    if (!user) {
      sendError(res, 404, 'NOT_FOUND', `There is no user named "${name}"`);

      return;
    }

    if (user.kind !== 'token') {
      sendError(
        res,
        400,
        'NOT_EDITABLE',
        'Only users added with an API token can be edited. Remove this user and add it again.',
      );

      return;
    }

    const nameError = getUserNameError(newName);

    if (nameError) {
      sendError(res, 400, 'INVALID_NAME', nameError);

      return;
    }

    if (newName !== name && users.get(newName)) {
      sendError(res, 409, 'NAME_TAKEN', `A user named "${newName}" already exists`);

      return;
    }

    let edited: SavedUser = { ...user, name: newName };

    if (token && token !== user.token) {
      const contextAtStart = users.context;
      const check = await checkUserToken(miAPI, token);

      // As when adding: the token belongs to the MI instance it was checked with.
      if (users.context !== contextAtStart || current.deps.miAPI !== miAPI || getUsers() !== users) {
        sendError(res, 409, 'CONTEXT_CHANGED', 'The dev server switched to another MI instance; edit the user again');

        return;
      }

      if (!check.ok) {
        if (check.rejected) {
          sendError(res, 400, 'INVALID_TOKEN', check.message);
        } else {
          sendError(res, 502, 'MI_UNAVAILABLE', check.message);
        }

        return;
      }

      // A token MI accepts: whatever MI said of the old one doesn't hold any more.
      const { state: _state, ...rest } = edited;

      edited = { ...rest, token, miUser: check.miUser };
    }

    // Removed, replaced or edited by another request while the token was being checked.
    if (users.get(name) !== user) {
      sendError(res, 409, 'USER_CHANGED', `The user "${name}" changed meanwhile; edit it again`);

      return;
    }

    if (newName === name && edited.token === user.token) {
      res.json({ user: toPublicUser(user, req) });

      return;
    }

    let saved: SavedUser;

    try {
      saved = users.replace(name, edited);
    } catch (error) {
      sendError(res, 409, 'NAME_TAKEN', error instanceof Error ? error.message : String(error));

      return;
    }

    logger.info(
      `${colors.blue('Edited user')} ${colors.yellow(name)}${newName !== name ? ` → ${colors.yellow(newName)}` : ''}${
        saved.token !== user.token ? ' (new API token)' : ''
      }`,
    );

    res.json({ user: toPublicUser(saved, req) });
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
