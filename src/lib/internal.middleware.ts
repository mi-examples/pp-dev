import express from 'express';

/**
 * Creates a fresh Express app for internal API routes.
 * Use this in configureServer to avoid "this.route is not a function" errors
 * when the server restarts after config changes (e.g. .env).
 */
export function createInternalServer(): express.Application {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  
  return app;
}

const internalServer = createInternalServer();

export default internalServer;
