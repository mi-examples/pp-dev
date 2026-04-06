import { URL } from 'url';
import type { ServerResponse } from 'http';

export const stringIsAValidUrl = (s: string, protocols: string[]) => {
  try {
    const parsed = new URL(s);

    if (protocols) {
      return parsed.protocol
        ? protocols.map((x) => `${x.toLowerCase()}:`).includes(parsed.protocol)
        : false;
    }

    return true;
  } catch (err) {
    return false;
  }
};

export const urlReplacer = (
  originalHost: string,
  destinationHost: string,
  content: string,
) => {
  const urlReplaceRegExp = new RegExp(
    `(!!)?(https?(:(\\\\)?/(\\\\)?/)${originalHost})`,
    'gi',
  );

  return content.replace(urlReplaceRegExp, (substring, ...args) => {
    if (substring.startsWith('!!')) {
      return args[1];
    }

    return `http${args[2]}${destinationHost}`;
  });
};

export const urlPathReplacer = (
  urlPath: string,
  destinationPath: string,
  content: string,
) => {
  const urlReplaceRegExp = new RegExp(
    `${urlPath.replace(/\\*\//gi, '\\\\/')}`,
    'gi',
  );
  const unescapedUrlReplaceRegExp = new RegExp(`${urlPath}`, 'gi');

  const replacedContent = content.replace(urlReplaceRegExp, destinationPath);

  return replacedContent === content
    ? replacedContent.replace(unescapedUrlReplaceRegExp, destinationPath)
    : replacedContent;
};

export const redirect = (
  res: ServerResponse,
  url: string,
  statusCode?: number,
) => {
  res.setHeader('location', url);
  res.statusCode = statusCode || 302;

  res.end();
};

export function cutUrlParams(url: string) {
  const urlParts = url.split('?');

  return urlParts[0];
}

export function cutUrlHash(url: string) {
  const urlParts = url.split('#');

  return urlParts[0];
}

/**
 * v7 only: dev URLs may use {@link templateName} in `/data/page/<name>/...` while the portal
 * resolves a different `internal_name`. Rewrites the first segment after `/data/page/` for
 * proxied requests to the backend. {@link internalPageName} is a plain path segment from the
 * API (no reserved characters); it is inserted as-is without encoding.
 */
export function rewriteDataPagePathForV7Proxy(
  requestUrl: string,
  v7Features: boolean,
  templateName: string | undefined,
  internalPageName: string | undefined,
): string {
  if (
    !v7Features ||
    !templateName ||
    !internalPageName ||
    templateName === internalPageName
  ) {
    return requestUrl;
  }

  try {
    const u = new URL(requestUrl, 'http://localhost');
    const m = u.pathname.match(/^\/data\/page\/([^/]+)(\/.*)?$/);

    if (!m) {
      return requestUrl;
    }

    let segmentDecoded: string;

    try {
      segmentDecoded = decodeURIComponent(m[1]);
    } catch {
      segmentDecoded = m[1];
    }

    if (segmentDecoded !== templateName) {
      return requestUrl;
    }

    const tail = m[2] ?? '';
    const newPath =
      `/data/page/${internalPageName}${tail}` + u.search + u.hash;

    return newPath;
  } catch {
    return requestUrl;
  }
}
