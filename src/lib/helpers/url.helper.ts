import { URL } from 'url';
import type { ServerResponse } from 'http';

export const stringIsAValidUrl = (s: string, protocols: string[]) => {
  try {
    const parsed = new URL(s);

    if (protocols) {
      return parsed.protocol ? protocols.map((x) => `${x.toLowerCase()}:`).includes(parsed.protocol) : false;
    }

    return true;
  } catch (err) {
    return false;
  }
};

export const urlReplacer = (originalHost: string, destinationHost: string, content: string) => {
  const urlReplaceRegExp = new RegExp(`(!!)?(https?(:(\\\\)?/(\\\\)?/)${originalHost})`, 'gi');

  return content.replace(urlReplaceRegExp, (substring, ...args) => {
    if (substring.startsWith('!!')) {
      return args[1];
    }

    return `http${args[2]}${destinationHost}`;
  });
};

export const urlPathReplacer = (urlPath: string, destinationPath: string, content: string) => {
  const urlReplaceRegExp = new RegExp(`${urlPath.replace(/\\*\//gi, '\\\\/')}`, 'gi');

  return content.replace(urlReplaceRegExp, destinationPath);
};

export const redirect = (res: ServerResponse, url: string, statusCode?: number) => {
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
