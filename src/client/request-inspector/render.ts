// HTML of the Request Inspector's list and detail. Buttons say what they do in `data-action`
// (and which side in `data-type`); main.ts handles the clicks in one place.
import {
  decodeTextBody,
  esc,
  formatBytes,
  formatDur,
  methodClass,
  sourceInfo,
  sourceLetter,
  statusClass,
  syntaxHighlightJson,
} from './format.js';

/** A request in the list (`GET /@api/requests`). */
export interface RequestSummary {
  id: string;
  method: string;
  url: string;
  statusCode?: number | null;
  duration?: number | null;
  responseSize?: number;
  source?: string;
  user?: string;
}

type Headers = Record<string, string | string[] | number | null | undefined>;

/** A request with its headers and bodies (`GET /@api/requests/:id`); bodies in base64. */
export interface RequestEntry extends RequestSummary {
  timestamp: number;
  requestHeaders: Headers;
  requestBody: string | null;
  requestBodySize: number;
  requestBodyTruncated: boolean;
  requestContentType: string;
  responseHeaders: Headers;
  responseBody: string | null;
  responseBodySize: number;
  responseBodyTruncated: boolean;
  responseContentType: string;
}

export type Side = 'request' | 'response';

export function renderListHtml(requests: RequestSummary[], selectedId: string | null): string {
  if (!requests.length) {
    return '<div class="empty-state"><div class="empty-icon">🔍</div><div>No matching requests</div></div>';
  }

  return requests
    .map((r) => {
      const sel = r.id === selectedId ? ' selected' : '';
      const dur = r.duration != null ? formatDur(r.duration) : '…';
      const source = r.source || 'local';

      return `<div class="req-item src-${source}${sel}" data-id="${esc(r.id)}">
      <span class="method-badge ${methodClass(r.method)}">${esc(r.method)}</span>
      ${r.user ? `<span class="user-chip" title="From the tab of user ${esc(r.user)}">${esc(r.user)}</span>` : ''}
      <span class="req-url" title="${esc(r.url)}">${esc(r.url)}</span>
      <span class="req-meta">
        <span class="req-status-row">
          <span class="source-letter src-letter-${source}">${sourceLetter(r.source)}</span>
          <span class="status-badge ${statusClass(r.statusCode)}">${r.statusCode || '…'}</span>
        </span>
        <span>${dur}</span>
        <span>${formatBytes(r.responseSize || 0)}</span>
      </span>
    </div>`;
    })
    .join('');
}

export function renderDetailInfoHtml(e: RequestEntry): string {
  const src = sourceInfo(e.source);

  return `
    <div class="info-item"><div class="info-label">Method</div><div class="info-value"><span class="method-badge ${methodClass(e.method)}">${esc(e.method)}</span></div></div>
    <div class="info-item"><div class="info-label">Status</div><div class="info-value"><span class="status-badge ${statusClass(e.statusCode)}">${e.statusCode || '—'}</span></div></div>
    <div class="info-item"><div class="info-label">Source</div><div class="info-value"><span class="source-chip ${src.cls}">${src.title}</span></div></div>
    <div class="info-item"><div class="info-label">User</div><div class="info-value">${e.user ? `<span class="user-chip">${esc(e.user)}</span>` : 'Original'}</div></div>
    <div class="info-item"><div class="info-label">Duration</div><div class="info-value">${e.duration != null ? formatDur(e.duration) : '—'}</div></div>
    <div class="info-item"><div class="info-label">Request</div><div class="info-value">${formatBytes(e.requestBodySize || 0)}</div></div>
    <div class="info-item"><div class="info-label">Response</div><div class="info-value">${formatBytes(e.responseBodySize || 0)}</div></div>
    <div class="info-item"><div class="info-label">Time</div><div class="info-value" style="font-size:11px">${new Date(e.timestamp).toLocaleTimeString()}</div></div>
  `;
}

export function renderDetailUrlHtml(e: RequestEntry): string {
  return `<span class="info-url-text" title="${esc(e.url)}">${esc(e.url)}</span><button class="section-btn" data-action="copy-url">Copy link</button>`;
}

function sectionHtml(title: string, badge: string, actions: string, body: string): string {
  return `<div class="detail-section">
    <div class="detail-section-hdr" data-action="toggle-section">
      <span class="toggle">▾</span>
      <span class="section-title">${title}</span>
      ${badge}
      ${actions ? `<div class="section-actions">${actions}</div>` : ''}
    </div>
    <div class="detail-section-body">${body}</div>
  </div>`;
}

export function renderHeadersSectionHtml(title: string, headers: Headers | undefined, type: Side): string {
  const entries = Object.entries(headers || {}).filter(([, v]) => v != null);
  const rows = entries
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(Array.isArray(v) ? v.join(', ') : String(v))}</td></tr>`)
    .join('');
  const copy = entries.length
    ? `<button class="section-btn" data-action="copy-headers" data-type="${type}">Copy</button>`
    : '';

  return sectionHtml(
    title,
    `<span class="section-badge">${entries.length}</span>`,
    copy,
    `<table class="kv-table">${rows}</table>`,
  );
}

function bodyContentHtml(b64: string | null, ct: string, truncated: boolean, size: number): string {
  if (!b64 && !truncated) {
    return '<div class="body-binary">No body</div>';
  }

  if (truncated) {
    return `<div class="body-binary">Body too large to capture (${formatBytes(size)})</div>`;
  }

  if (ct.includes('json') || ct.includes('/javascript') || ct === 'text/plain') {
    const text = decodeTextBody(b64!);

    return ct.includes('json')
      ? `<pre class="body-content json">${syntaxHighlightJson(text)}</pre>`
      : `<pre class="body-content">${esc(text)}</pre>`;
  }

  if (ct.startsWith('text/')) {
    return `<pre class="body-content">${esc(decodeTextBody(b64!))}</pre>`;
  }

  if (ct.startsWith('image/') && size < 1024 * 1024) {
    return `<img class="body-image" src="data:${esc(ct)};base64,${b64}" alt="image"/>`;
  }

  if (ct === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(decodeTextBody(b64!));
    const rows = [...params.entries()].map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');

    return `<table class="kv-table">${rows}</table>`;
  }

  return `<div class="body-binary">Binary data — ${formatBytes(size)} (${esc(ct || 'unknown type')})</div>`;
}

export function renderBodySectionHtml(
  title: string,
  b64: string | null,
  contentType: string | undefined,
  truncated: boolean,
  size: number,
  type: Side,
  captureLimit: number,
): string {
  const ct = (contentType || '').toLowerCase().split(';')[0].trim();
  const isText =
    ct.includes('json') ||
    ct.startsWith('text/') ||
    ct.includes('/javascript') ||
    ct === 'application/xml' ||
    ct === 'application/x-www-form-urlencoded';
  const copy =
    b64 && isText ? `<button class="section-btn" data-action="copy-body" data-type="${type}">Copy</button>` : '';
  const save = b64 ? `<button class="section-btn" data-action="save-body" data-type="${type}">Save</button>` : '';
  const note = truncated
    ? `<div class="truncated-note">⚠ Body was larger than the capture limit (${formatBytes(captureLimit)})</div>`
    : '';

  return sectionHtml(
    title,
    size ? `<span class="section-badge">${formatBytes(size)}</span>` : '',
    copy + save,
    bodyContentHtml(b64, ct, truncated, size) + note,
  );
}

export function renderDetailSectionsHtml(e: RequestEntry, captureLimit: number): string {
  return [
    renderHeadersSectionHtml('Request Headers', e.requestHeaders, 'request'),
    renderBodySectionHtml(
      'Request Body',
      e.requestBody,
      e.requestContentType,
      e.requestBodyTruncated,
      e.requestBodySize,
      'request',
      captureLimit,
    ),
    renderHeadersSectionHtml('Response Headers', e.responseHeaders, 'response'),
    renderBodySectionHtml(
      'Response Body',
      e.responseBody,
      e.responseContentType,
      e.responseBodyTruncated,
      e.responseBodySize,
      'response',
      captureLimit,
    ),
  ].join('');
}
