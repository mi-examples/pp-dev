import { IncomingMessage, ServerResponse } from 'node:http';
import { RequestStore, type RequestSource } from './request-store.js';
import { UserRegistry, userRegistry } from './user-registry.js';
import { MI_SESSION_COOKIE } from './helpers/cookie.helper.js';

const DEFAULT_CAPTURE_LIMIT = 10 * 1024 * 1024;

const REDACTED = '<redacted>';

// The MI session cookie's value, in a `Cookie` header (`a=1; metric_insights_session=…`) or at the
// start of a `Set-Cookie` header.
const SESSION_COOKIE_IN_COOKIE = new RegExp(`(^|;\\s*)(${MI_SESSION_COOKIE}=)[^;]*`, 'gi');
const SESSION_COOKIE_IN_SET_COOKIE = new RegExp(`^(\\s*${MI_SESSION_COOKIE}=)[^;]*`, 'i');

/**
 * Copies of the captured headers without credentials: an `Authorization` value, MI's regular
 * `Token` header and the MI session cookie. With several users (PP-4592) the inspector shows requests of all of them, and their
 * sessions and tokens have no business on the page.
 */
export function redactRequestHeaders(
  headers: IncomingMessage['headers'],
): Record<string, string | string[] | undefined> {
  const redacted: Record<string, string | string[] | undefined> = { ...headers };

  if (typeof redacted.authorization === 'string') {
    const [scheme, credentials] = redacted.authorization.split(/\s+/, 2);

    redacted.authorization = credentials === undefined ? REDACTED : `${scheme} ${REDACTED}`;
  }

  if (redacted.token !== undefined) {
    redacted.token = REDACTED;
  }

  if (typeof redacted.cookie === 'string') {
    redacted.cookie = redacted.cookie.replace(SESSION_COOKIE_IN_COOKIE, `$1$2${REDACTED}`);
  }

  return redacted;
}

export function redactResponseHeaders(
  headers: ReturnType<ServerResponse['getHeaders']>,
): Record<string, number | string | string[] | undefined> {
  const redacted = { ...headers } as Record<string, number | string | string[] | undefined>;
  const setCookie = redacted['set-cookie'];
  const redactCookie = (cookie: string) => cookie.replace(SESSION_COOKIE_IN_SET_COOKIE, `$1${REDACTED}`);

  if (Array.isArray(setCookie)) {
    redacted['set-cookie'] = setCookie.map(redactCookie);
  } else if (typeof setCookie === 'string') {
    redacted['set-cookie'] = redactCookie(setCookie);
  }

  return redacted;
}

/** MI's login and other authentication endpoints: their bodies carry passwords and one-time codes. */
const AUTH_PATH_REGEXP = /^\/(?:login|auth)(?:[/?#]|$)/i;

/** Body fields that hold credentials, wherever they are posted. */
const CREDENTIAL_FIELD_REGEXP = /pass(?:word|wd|code)?|pwd|secret|token|otp|mfa|2fa/i;

/** `value` with credential fields redacted; `found` says whether there were any. */
function redactJsonValue(value: unknown, found: { any: boolean }): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item, found));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => {
        if (CREDENTIAL_FIELD_REGEXP.test(key)) {
          found.any = true;

          return [key, REDACTED];
        }

        return [key, redactJsonValue(inner, found)];
      }),
    );
  }

  return value;
}

/**
 * The captured request body without credentials: nothing of an authentication request (the
 * username/password login of a saved user goes through the proxy), and credential-like fields of
 * form and JSON bodies elsewhere.
 */
export function redactRequestBody(url: string, contentType: string | undefined, body: Buffer | null): Buffer | null {
  if (!body) {
    return body;
  }

  if (AUTH_PATH_REGEXP.test(url)) {
    return Buffer.from(REDACTED);
  }

  const type = (contentType ?? '').split(';', 1)[0].trim().toLowerCase();

  try {
    // A body without credentials is kept byte for byte.
    if (type === 'application/x-www-form-urlencoded') {
      const params = new URLSearchParams(body.toString('utf8'));
      const credentialKeys = [...new Set(params.keys())].filter((key) => CREDENTIAL_FIELD_REGEXP.test(key));

      credentialKeys.forEach((key) => params.set(key, REDACTED));

      return credentialKeys.length ? Buffer.from(params.toString()) : body;
    }

    if (type === 'application/json' || type.endsWith('+json')) {
      const found = { any: false };
      const redacted = redactJsonValue(JSON.parse(body.toString('utf8')), found);

      return found.any ? Buffer.from(JSON.stringify(redacted)) : body;
    }
  } catch {
    // Not parseable: keep the body as it is.
  }

  return body;
}

const SKIP_PREFIXES = ['/@pp-dev/', '/@api/', '/_next/', '/__nextjs_', '/@vite', '/@metricinsights', '/@'];

const SKIP_EXACT = new Set(['/favicon.ico', '/installHook.js.map']);

export function createRequestCaptureMiddleware(
  store: RequestStore,
  captureLimit = DEFAULT_CAPTURE_LIMIT,
  users: UserRegistry = userRegistry,
) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = req.url || '/';
    const pathname = url.split('?')[0];

    if (SKIP_PREFIXES.some((p) => url.startsWith(p)) || SKIP_EXACT.has(pathname)) {
      next();

      return;
    }

    const id = store.allocateId();
    // Resolved up front: a logout removes the user before the response ends.
    const user = users.resolve(req)?.user?.name;
    const startTime = Date.now();

    // Capture the request body by patching req.emit rather than attaching a 'data'
    // listener: a listener would switch the stream into flowing mode, and buffered
    // chunks would be emitted (and lost) before a downstream consumer — e.g. the
    // proxy — attaches its own reader. Patching emit observes chunks only when
    // something downstream actually reads the stream, leaving its state untouched.
    const reqChunks: Buffer[] = [];
    let reqSize = 0;
    let reqTruncated = false;

    const origReqEmit = req.emit.bind(req);

    req.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
      if (event === 'data' && !reqTruncated) {
        const chunk = args[0];
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));

        reqSize += buf.byteLength;

        if (reqSize <= captureLimit) {
          reqChunks.push(buf);
        } else {
          reqTruncated = true;
          reqChunks.length = 0; // free memory for partial chunks
        }
      }

      return origReqEmit(event as never, ...(args as never[]));
    }) as typeof req.emit;

    // Capture response body by wrapping write/end
    const resChunks: Buffer[] = [];
    let resSize = 0;
    let resTruncated = false;

    const origWrite = res.write.bind(res) as typeof res.write;
    const origEnd = res.end.bind(res) as typeof res.end;

    function captureChunk(chunk: unknown, encoding?: BufferEncoding): void {
      if (resTruncated || chunk == null) {
        return;
      }

      try {
        const buf = Buffer.isBuffer(chunk)
          ? chunk
          : typeof chunk === 'string'
            ? Buffer.from(chunk, encoding)
            : ArrayBuffer.isView(chunk)
              ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
              : chunk instanceof ArrayBuffer
                ? Buffer.from(chunk)
                : Buffer.from(String(chunk));

        resSize += buf.byteLength;

        if (resSize <= captureLimit) {
          resChunks.push(buf);
        } else {
          resTruncated = true;
          resChunks.length = 0;
        }
      } catch {
        // ignore encoding errors on capture
      }
    }

    function getWriteEncoding(args: unknown[]): BufferEncoding | undefined {
      return typeof args[0] === 'string' ? (args[0] as BufferEncoding) : undefined;
    }

    function detectSource(): RequestSource {
      const headers = res.getHeaders();

      if (headers['x-pp-proxy']) {
        return headers['x-pp-cache'] === 'hit' ? 'proxy-cache' : 'proxy';
      }

      return 'local';
    }

    let finalized = false;

    function finalize(): void {
      if (finalized) {
        return;
      }

      finalized = true;

      const requestBody = redactRequestBody(
        url,
        typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined,
        !reqTruncated && reqChunks.length > 0 ? Buffer.concat(reqChunks) : null,
      );
      const responseBody = !resTruncated && resChunks.length > 0 ? Buffer.concat(resChunks) : null;

      store.add({
        id,
        timestamp: startTime,
        method: req.method || 'GET',
        url,
        statusCode: res.statusCode ?? null,
        duration: Date.now() - startTime,
        source: detectSource(),
        user,
        requestHeaders: redactRequestHeaders(req.headers),
        requestBody,
        requestBodyTruncated: reqTruncated,
        responseHeaders: redactResponseHeaders(res.getHeaders()),
        responseBody,
        responseBodyTruncated: resTruncated,
      });
    }

    (res as any).write = function (chunk: any, ...args: any[]): boolean {
      captureChunk(chunk, getWriteEncoding(args));

      return (origWrite as any)(chunk, ...args);
    };

    (res as any).end = function (chunk?: any, ...args: any[]): any {
      if (typeof chunk !== 'function') {
        captureChunk(chunk, getWriteEncoding(args));
      }

      finalize();

      return (origEnd as any)(chunk, ...args);
    };

    next();
  };
}
