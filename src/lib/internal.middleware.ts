import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { createOriginGuard, type AllowedHosts } from './helpers/origin-guard.js';

/**
 * The largest JSON body the internal API accepts. Express' default (100 kb) is too small for a
 * template's `__template_variables.json` with long option lists, and an over-limit save used to
 * fail with an HTML error page the variables editor couldn't show.
 */
export const INTERNAL_JSON_BODY_LIMIT = '10mb';

/**
 * Answers body-parser errors (a body over the limit, malformed JSON) with `{ error }` JSON, the
 * shape every `/@api/*` client reads, instead of Express' HTML error page. Anything else is left
 * to the next error handler.
 */
const bodyParserErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  const status = typeof err?.status === 'number' ? err.status : undefined;

  if (!status || status < 400 || status >= 500 || typeof err.type !== 'string' || res.headersSent) {
    next(err);

    return;
  }

  const error =
    err.type === 'entity.too.large'
      ? `The request body is larger than the dev server accepts (${INTERNAL_JSON_BODY_LIMIT}).`
      : `The request body could not be read: ${err.message}`;

  res.status(status).json({ error });
};

/**
 * Creates a fresh Express app for internal API routes.
 * Use this in configureServer to avoid "this.route is not a function" errors
 * when the server restarts after config changes (e.g. .env).
 *
 * @param options.allowedHosts - `server.allowedHosts`, whose exact names may call the API too.
 */
export function createInternalServer({ allowedHosts = [] }: { allowedHosts?: AllowedHosts } = {}): express.Application {
  const app = express();

  // First, before any body is read: other sites' pages must not reach the API (see crossOriginReason).
  app.use(createOriginGuard(allowedHosts));
  app.use(express.json({ limit: INTERNAL_JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true }));
  app.use(bodyParserErrorHandler);

  return app;
}
