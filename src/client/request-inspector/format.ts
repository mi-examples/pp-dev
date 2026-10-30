// Formatting helpers of the Request Inspector page: pure, so the tests import them directly.

/** Escapes text for HTML content and double-quoted attribute values. */
export function esc(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function formatBytes(bytes: number | undefined): string {
  const b = bytes || 0;

  if (b < 1024) {
    return b + ' B';
  }

  if (b < 1024 * 1024) {
    return (b / 1024).toFixed(1) + ' KB';
  }

  if (b < 1024 * 1024 * 1024) {
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  }

  return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export function formatDur(ms: number): string {
  if (ms < 1000) {
    return ms + 'ms';
  }

  return (ms / 1000).toFixed(2) + 's';
}

const METHOD_CLASSES: Record<string, string> = {
  GET: 'm-GET',
  POST: 'm-POST',
  PUT: 'm-PUT',
  PATCH: 'm-PATCH',
  DELETE: 'm-DELETE',
  HEAD: 'm-HEAD',
  OPTIONS: 'm-OPTIONS',
};

export function methodClass(method: string): string {
  return METHOD_CLASSES[method] || 'm-other';
}

export function statusClass(status: number | null | undefined): string {
  if (!status) {
    return 's-pending';
  }

  return ['', '', 's-2xx', 's-3xx', 's-4xx', 's-5xx'][Math.floor(status / 100)] || '';
}

export function sourceInfo(source: string | undefined): { cls: string; title: string } {
  if (source === 'proxy') {
    return { cls: 'src-proxy', title: 'Backend (live)' };
  }

  if (source === 'proxy-cache') {
    return { cls: 'src-proxy-cache', title: 'Backend (cached)' };
  }

  return { cls: 'src-local', title: 'Local (dev server)' };
}

export function sourceLetter(source: string | undefined): string {
  if (source === 'proxy') {
    return 'P';
  }

  if (source === 'proxy-cache') {
    return 'C';
  }

  return 'L';
}

const FILE_EXTENSIONS: Record<string, string> = {
  'application/json': 'json',
  'text/html': 'html',
  'text/css': 'css',
  'text/javascript': 'js',
  'application/javascript': 'js',
  'text/plain': 'txt',
  'text/xml': 'xml',
  'application/xml': 'xml',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-www-form-urlencoded': 'txt',
  'application/octet-stream': 'bin',
};

/** The file extension a saved body of `contentType` gets. */
export function fileExt(contentType: string | undefined): string {
  return FILE_EXTENSIONS[(contentType || '').split(';')[0].trim().toLowerCase()] || 'bin';
}

export function decodeBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function decodeTextBody(b64: string): string {
  return new TextDecoder('utf-8').decode(decodeBase64(b64));
}

/** Pretty-prints JSON with highlighting spans; invalid JSON comes back as escaped plain text. */
export function syntaxHighlightJson(text: string): string {
  let str: string;

  try {
    str = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Invalid JSON can contain arbitrary HTML. It cannot be token-highlighted safely because
    // unmatched text is preserved by the replacement below, so render it as escaped plain text.
    return esc(text);
  }

  return str.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"\s*:?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (m) => {
      if (/^"/.test(m)) {
        if (/:$/.test(m)) {
          return '<span class="body-json-key">' + esc(m) + '</span>';
        }

        return '<span class="body-json-str">' + esc(m) + '</span>';
      }

      if (/true|false/.test(m)) {
        return '<span class="body-json-bool">' + m + '</span>';
      }

      if (/null/.test(m)) {
        return '<span class="body-json-null">' + m + '</span>';
      }

      return '<span class="body-json-num">' + m + '</span>';
    },
  );
}
