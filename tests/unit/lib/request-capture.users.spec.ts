import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createRequestCaptureMiddleware,
  redactRequestHeaders,
  redactResponseHeaders,
} from '../../../src/lib/request-capture.middleware.js';
import { RequestStore } from '../../../src/lib/request-store.js';
import { UserRegistry } from '../../../src/lib/user-registry.js';

/**
 * PP-4598: the Request Inspector shows which user each request was sent as, and keeps credentials
 * (an `Authorization` value, the MI session cookie) off the page, since it lists the requests of
 * every user.
 */

function capture(users: UserRegistry, headers: IncomingMessage['headers'], responseHeaders = {}) {
  const store = new RequestStore(1024 * 1024);
  const req = new PassThrough() as unknown as IncomingMessage;
  const res = new PassThrough() as unknown as ServerResponse;

  req.method = 'GET';
  req.url = '/api/user';
  req.headers = headers;
  res.statusCode = 200;
  (res as any).getHeaders = () => responseHeaders;

  createRequestCaptureMiddleware(store, 1024, users)(req, res, () => {});
  res.end();

  const [meta] = store.list();

  return { meta, entry: store.get(meta.id)! };
}

describe('request capture — users', () => {
  const users = new UserRegistry();

  users.add({ name: 'viewer', kind: 'token', token: 'viewer-token' });

  it('records the saved user of a request to its host', () => {
    const { meta, entry } = capture(users, { host: 'viewer.localhost:3000' });

    expect(meta.user).toBe('viewer');
    expect(entry.user).toBe('viewer');
  });

  it('records no user for the original user', () => {
    expect(capture(users, { host: 'localhost:3000' }).meta.user).toBeUndefined();
  });

  it('records the default user for the main host', () => {
    const withDefault = new UserRegistry();

    withDefault.add({ name: 'viewer', kind: 'token', token: 'viewer-token' });
    withDefault.setDefaultUser('viewer');

    expect(capture(withDefault, { host: 'localhost:3000' }).meta.user).toBe('viewer');
  });

  it('stores headers without credentials', () => {
    const { entry } = capture(
      users,
      {
        host: 'viewer.localhost:3000',
        authorization: 'Bearer app-token',
        cookie: 'theme=dark; metric_insights_session=SECRET; lang=en',
      },
      { 'set-cookie': ['metric_insights_session=NEW; path=/; httponly', 'theme=dark; path=/'] },
    );

    expect(entry.requestHeaders).toMatchObject({
      authorization: 'Bearer <redacted>',
      cookie: 'theme=dark; metric_insights_session=<redacted>; lang=en',
    });
    expect(entry.responseHeaders['set-cookie']).toEqual([
      'metric_insights_session=<redacted>; path=/; httponly',
      'theme=dark; path=/',
    ]);
    expect(JSON.stringify(entry)).not.toMatch(/SECRET|NEW|app-token/);
  });
});

describe('redactRequestHeaders / redactResponseHeaders', () => {
  it('redacts an Authorization value without a scheme', () => {
    expect(redactRequestHeaders({ authorization: 'opaque' }).authorization).toBe('<redacted>');
  });

  it('leaves headers without credentials as they are, and the originals untouched', () => {
    const headers = { host: 'localhost:3000', cookie: 'theme=dark' };

    expect(redactRequestHeaders(headers)).toEqual(headers);

    const sessionHeaders = { cookie: 'metric_insights_session=SECRET' };

    redactRequestHeaders(sessionHeaders);

    expect(sessionHeaders.cookie).toBe('metric_insights_session=SECRET');
  });

  it('redacts a single Set-Cookie string', () => {
    expect(redactResponseHeaders({ 'set-cookie': 'metric_insights_session=X; path=/' })['set-cookie']).toBe(
      'metric_insights_session=<redacted>; path=/',
    );
  });
});
