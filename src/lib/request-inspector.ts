import type { Application } from 'express';
import { RequestStore } from './request-store.js';

export const INSPECTOR_PATH = '/@pp-dev/inspector';

export function registerInspectorRoutes(app: Application, store: RequestStore, captureLimit = 10 * 1024 * 1024): void {
  // ── API: list requests ────────────────────────────────────────────────────────
  app.get('/@api/requests', (req, res) => {
    const { limit, offset, method, search } = req.query as Record<string, string | undefined>;
    const items = store.list({
      limit: limit !== undefined ? (Number.isFinite(parseInt(limit, 10)) ? parseInt(limit, 10) : undefined) : undefined,
      offset:
        offset !== undefined ? (Number.isFinite(parseInt(offset, 10)) ? parseInt(offset, 10) : undefined) : undefined,
      method,
      search,
    });

    res.json({
      requests: items,
      total: store.size,
      memoryUsage: store.memoryUsage,
      maxMemory: store.maxMemory,
    });
  });

  // ── API: stats ────────────────────────────────────────────────────────────────
  app.get('/@api/requests/stats', (_req, res) => {
    res.json({
      total: store.size,
      memoryUsage: store.memoryUsage,
      maxMemory: store.maxMemory,
      memoryUsageFormatted: formatBytes(store.memoryUsage),
      maxMemoryFormatted: formatBytes(store.maxMemory),
    });
  });

  // ── API: get single request with bodies ───────────────────────────────────────
  app.get('/@api/requests/:id', (req, res) => {
    const entry = store.get(req.params.id);

    if (!entry) {
      res.status(404).json({ error: 'Not found', id: req.params.id });

      return;
    }

    const requestContentType = normalizeHeaderValue(entry.requestHeaders['content-type']);
    const responseContentType = normalizeHeaderValue(entry.responseHeaders['content-type']);

    res.json({
      id: entry.id,
      timestamp: entry.timestamp,
      method: entry.method,
      url: entry.url,
      statusCode: entry.statusCode,
      duration: entry.duration,
      source: entry.source,
      requestHeaders: entry.requestHeaders,
      requestBody: entry.requestBody ? entry.requestBody.toString('base64') : null,
      requestBodySize: entry.requestBody?.byteLength ?? 0,
      requestBodyTruncated: entry.requestBodyTruncated,
      requestContentType,
      responseHeaders: entry.responseHeaders,
      responseBody: entry.responseBody ? entry.responseBody.toString('base64') : null,
      responseBodySize: entry.responseBody?.byteLength ?? 0,
      responseBodyTruncated: entry.responseBodyTruncated,
      responseContentType,
    });
  });

  // ── API: clear all requests ───────────────────────────────────────────────────
  app.delete('/@api/requests', (_req, res) => {
    store.clear();
    res.json({ ok: true });
  });

  // ── Web UI ────────────────────────────────────────────────────────────────────
  app.get(INSPECTOR_PATH, (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(getInspectorHtml(captureLimit));
  });
}

function normalizeHeaderValue(v: string | string[] | number | undefined): string {
  if (Array.isArray(v)) {
    return v[0] ?? '';
  }

  return String(v ?? '');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getInspectorHtml(captureLimit: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Request Inspector — pp-dev</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#1a1a1e;--bg2:#222228;--bg3:#2a2a32;--bg4:#32323c;
  --border:#3a3a46;--border2:#4a4a58;
  --text:#e0e0f0;--text2:#a0a0b8;--text3:#606078;
  --accent:#6e8efb;--accent2:#a78bfa;
  --green:#4ade80;--red:#f87171;--yellow:#fbbf24;--blue:#60a5fa;--orange:#fb923c;--purple:#c084fc;
  --font-mono:'Cascadia Code','Fira Code','JetBrains Mono',Consolas,monospace;
  --font-ui:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:var(--font-ui);font-size:13px;line-height:1.5}

/* ── Layout ── */
.app{display:flex;flex-direction:column;height:100vh}
.toolbar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg2);border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap}
.toolbar-title{font-weight:600;font-size:14px;color:var(--text);margin-right:4px}
.toolbar-badge{font-size:11px;padding:2px 7px;border-radius:10px;background:var(--bg4);color:var(--text2)}
.toolbar-spacer{flex:1}
.mem-bar-wrap{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text2)}
.mem-bar{width:80px;height:6px;background:var(--bg4);border-radius:3px;overflow:hidden}
.mem-bar-fill{height:100%;background:var(--accent);transition:width .4s}

.split{display:flex;flex:1;overflow:hidden}
.pane-list{width:380px;min-width:200px;max-width:60%;border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
.pane-detail{flex:1;display:flex;flex-direction:column;overflow:hidden}

/* ── Filter bar ── */
.filter-bar{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;background:var(--bg2);border-bottom:1px solid var(--border);flex-shrink:0}
.filter-input{flex:1 1 120px;min-width:0;background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px;outline:none}
.filter-input:focus{border-color:var(--accent)}
.filter-selects{display:flex;gap:6px;flex-shrink:0}
.filter-select{background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:4px 6px;border-radius:4px;font-size:12px;outline:none;cursor:pointer;max-width:90px}
.filter-select:focus{border-color:var(--accent)}

/* ── Request list ── */
.req-list{flex:1;overflow-y:auto;overflow-x:hidden}
.req-list::-webkit-scrollbar{width:6px}
.req-list::-webkit-scrollbar-track{background:var(--bg)}
.req-list::-webkit-scrollbar-thumb{background:var(--bg4);border-radius:3px}
.req-item{display:flex;align-items:center;gap:8px;padding:7px 10px 7px 9px;border-bottom:1px solid var(--border);border-left:3px solid transparent;cursor:pointer;user-select:none;transition:background .1s,border-left-color .1s}
.req-item:hover{background:var(--bg3)}
.req-item.selected{background:var(--bg4);border-left-color:var(--accent) !important}
.req-item.src-proxy{border-left-color:#6366f1}
.req-item.src-proxy-cache{border-left-color:#d97706}
.req-item.src-local{border-left-color:transparent}

.method-badge{font-size:10px;font-weight:700;padding:2px 5px;border-radius:3px;min-width:38px;text-align:center;letter-spacing:.4px;flex-shrink:0}
.m-GET{background:#1a3a2a;color:var(--green)}
.m-POST{background:#1a2a3a;color:var(--blue)}
.m-PUT{background:#3a2a1a;color:var(--orange)}
.m-PATCH{background:#2a2a1a;color:var(--yellow)}
.m-DELETE{background:#3a1a1a;color:var(--red)}
.m-HEAD,.m-OPTIONS{background:#2a1a3a;color:var(--purple)}
.m-other{background:var(--bg4);color:var(--text2)}

.req-url{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--text)}
.req-meta{display:flex;flex-direction:column;align-items:flex-end;gap:1px;flex-shrink:0;font-size:10px;color:var(--text3)}
.req-status-row{display:flex;align-items:center;gap:4px}
.source-letter{font-size:9px;font-weight:700;width:15px;height:15px;display:flex;align-items:center;justify-content:center;border-radius:2px;flex-shrink:0}
.src-letter-proxy{background:#1e1e3a;color:#6366f1}
.src-letter-proxy-cache{background:#2a2010;color:#d97706}
.src-letter-local{background:var(--bg4);color:var(--text3)}
.status-badge{font-size:10px;font-weight:600;padding:1px 4px;border-radius:2px}
.s-2xx{color:var(--green)}
.s-3xx{color:var(--blue)}
.s-4xx{color:var(--yellow)}
.s-5xx{color:var(--red)}
.s-pending{color:var(--text3)}

.source-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:500;padding:2px 7px;border-radius:10px}
.src-local{background:#1e2a1e;color:#86efac}
.src-proxy{background:#1e1e3a;color:#a5b4fc}
.src-proxy-cache{background:#2a2010;color:#fcd34d}

.empty-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--text3);gap:8px;padding:40px}
.empty-icon{font-size:40px;opacity:.5}

/* ── Detail pane ── */
.detail-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--text3);gap:8px}
.detail-scroll{flex:1;overflow-y:auto;overflow-x:hidden;padding:0}
.detail-scroll::-webkit-scrollbar{width:6px}
.detail-scroll::-webkit-scrollbar-track{background:var(--bg)}
.detail-scroll::-webkit-scrollbar-thumb{background:var(--bg4);border-radius:3px}

.detail-section{border-bottom:1px solid var(--border)}
.detail-section-hdr{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg2);cursor:pointer;user-select:none;position:sticky;top:0;z-index:1}
.detail-section-hdr:hover{background:var(--bg3)}
.detail-section-hdr .toggle{font-size:10px;color:var(--text3)}
.section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text2)}
.section-badge{font-size:10px;padding:1px 5px;border-radius:8px;background:var(--bg4);color:var(--text3)}
.section-actions{display:flex;gap:4px;margin-left:auto;align-items:center}
.section-btn{font-size:10px;padding:1px 7px;border-radius:3px;border:1px solid var(--border);background:transparent;color:var(--text3);cursor:pointer;line-height:1.6;transition:all .1s;font-family:var(--font-ui)}
.section-btn:hover{background:var(--bg4);color:var(--text);border-color:var(--border2)}
.detail-section-body{padding:8px 12px;font-family:var(--font-mono);font-size:12px}
.detail-section-body.collapsed{display:none}

.kv-table{width:100%;border-collapse:collapse}
.kv-table tr:hover td{background:var(--bg3)}
.kv-table td{padding:2px 0;vertical-align:top}
.kv-table td:first-child{color:var(--text2);white-space:nowrap;padding-right:12px;min-width:140px;max-width:220px;overflow:hidden;text-overflow:ellipsis}
.kv-table td:last-child{color:var(--text);word-break:break-all}

.body-content{white-space:pre-wrap;word-break:break-all;color:var(--text);line-height:1.6;max-height:400px;overflow:auto}
.body-content.json{color:#c9d1d9}
.body-json-key{color:#79b8ff}
.body-json-str{color:#9ecbff}
.body-json-num{color:#f8c555}
.body-json-bool{color:#f97583}
.body-json-null{color:#f97583;font-style:italic}
.body-binary{color:var(--text3);font-style:italic;padding:8px 0}
.body-image{max-width:100%;max-height:300px;object-fit:contain;margin-top:4px;border:1px solid var(--border);border-radius:4px}
.truncated-note{font-size:11px;color:var(--yellow);margin-top:4px;font-family:var(--font-ui)}

.detail-info-bar{display:flex;gap:16px;padding:10px 12px;background:var(--bg2);border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap}
.info-item{display:flex;flex-direction:column;gap:2px}
.info-label{font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px}
.info-value{font-size:13px;font-weight:600;color:var(--text)}
.info-url{display:flex;align-items:center;gap:8px;font-size:11px;font-family:var(--font-mono);color:var(--text2);padding:6px 12px;border-bottom:1px solid var(--border);background:var(--bg)}
.info-url-text{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── Buttons ── */
.btn{padding:4px 10px;border-radius:4px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:12px;cursor:pointer;transition:background .1s}
.btn:hover{background:var(--bg4);border-color:var(--border2)}
.btn-danger:hover{background:#3a1a1a;border-color:#6a2a2a;color:var(--red)}
.btn-sm{padding:2px 7px;font-size:11px}

/* ── Live indicator ── */
.live-dot{width:7px;height:7px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

/* ── Scrollbar ── */
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--bg4);border-radius:3px}
</style>
</head>
<body>
<div class="app">
  <div class="toolbar">
    <span class="toolbar-title">🔍 Request Inspector</span>
    <span class="live-dot" title="Live"></span>
    <span class="toolbar-badge" id="req-count">0 requests</span>
    <div class="mem-bar-wrap">
      <div class="mem-bar"><div class="mem-bar-fill" id="mem-fill" style="width:0%"></div></div>
      <span id="mem-text">0 B / 1 GB</span>
    </div>
    <div class="toolbar-spacer"></div>
    <button class="btn btn-sm btn-danger" onclick="clearAll()">Clear</button>
  </div>
  <div class="split">
    <div class="pane-list">
      <div class="filter-bar">
        <input class="filter-input" id="search-input" placeholder="Filter by URL…" oninput="applyFilter()" />
        <div class="filter-selects">
          <select class="filter-select" id="method-select" onchange="applyFilter()">
            <option value="">All</option>
            <option>GET</option><option>POST</option><option>PUT</option>
            <option>PATCH</option><option>DELETE</option><option>HEAD</option>
          </select>
          <select class="filter-select" id="status-select" onchange="applyFilter()">
            <option value="">All</option>
            <option value="2">2xx</option><option value="3">3xx</option>
            <option value="4">4xx</option><option value="5">5xx</option>
          </select>
          <select class="filter-select" id="source-select" onchange="applyFilter()">
            <option value="">All</option>
            <option value="local">Local</option>
            <option value="proxy">Proxy</option>
            <option value="proxy-cache">Cached</option>
          </select>
        </div>
      </div>
      <div class="req-list" id="req-list">
        <div class="empty-state">
          <div class="empty-icon">📡</div>
          <div>No requests captured yet</div>
          <div style="font-size:11px">Requests to the dev server will appear here</div>
        </div>
      </div>
    </div>
    <div class="pane-detail">
      <div class="detail-empty" id="detail-empty">
        <div style="font-size:32px;opacity:.3">←</div>
        <div>Select a request to inspect</div>
      </div>
      <div id="detail-panel" style="display:none;flex:1;flex-direction:column;overflow:hidden">
        <div class="detail-info-bar" id="detail-info"></div>
        <div class="info-url" id="detail-url"></div>
        <div class="detail-scroll" id="detail-scroll"></div>
      </div>
    </div>
  </div>
</div>
<script>
(function(){
'use strict';

const CAPTURE_LIMIT = ${captureLimit};

let allRequests = [];
let filteredRequests = [];
let selectedId = null;
let currentEntry = null;

const listEl = document.getElementById('req-list');
const detailEmpty = document.getElementById('detail-empty');
const detailPanel = document.getElementById('detail-panel');
const detailInfo = document.getElementById('detail-info');
const detailUrl = document.getElementById('detail-url');
const detailScroll = document.getElementById('detail-scroll');

// ── Fetch request list ────────────────────────────────────────────────────────
async function fetchList() {
  try {
    const r = await fetch('/@api/requests');
    const data = await r.json();

    allRequests = data.requests || [];
    updateStats(data);
    applyFilter();

    if (selectedId && !allRequests.find(r => r.id === selectedId)) {
      selectedId = null;
      showDetailEmpty();
    }
  } catch(e) {}
}

function updateStats(data) {
  const pct = data.maxMemory > 0 ? Math.min(100, (data.memoryUsage / data.maxMemory) * 100) : 0;

  document.getElementById('req-count').textContent = data.total + ' request' + (data.total !== 1 ? 's' : '');
  document.getElementById('mem-fill').style.width = pct + '%';
  document.getElementById('mem-text').textContent = formatBytes(data.memoryUsage) + ' / ' + formatBytes(data.maxMemory);
}

// ── Filter ────────────────────────────────────────────────────────────────────
function applyFilter() {
  const search = document.getElementById('search-input').value.toLowerCase();
  const method = document.getElementById('method-select').value;
  const status = document.getElementById('status-select').value;
  const source = document.getElementById('source-select').value;

  filteredRequests = allRequests.filter(r => {
    if (method && r.method !== method) {
      return false;
    }

    if (status && !String(r.statusCode || '').startsWith(status)) {
      return false;
    }

    if (source && r.source !== source) {
      return false;
    }

    if (search && !r.url.toLowerCase().includes(search)) {
      return false;
    }

    return true;
  });

  renderList();
}

// ── Render list ───────────────────────────────────────────────────────────────
function isAtBottom() {
  return listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 16;
}

function renderList() {
  const atBottom = isAtBottom();

  if (!filteredRequests.length) {
    listEl.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><div>No matching requests</div></div>';

    return;
  }

  const html = filteredRequests.map(r => {
    const sel = r.id === selectedId ? ' selected' : '';
    const mClass = methodClass(r.method);
    const sClass = statusClass(r.statusCode);
    const dur = r.duration != null ? formatDur(r.duration) : '…';
    const size = formatBytes((r.responseSize || 0));
    const srcCls = 'src-' + (r.source || 'local');
    const sLetter = sourceLetter(r.source);
    const sLetterCls = 'src-letter-' + (r.source || 'local').replace(/-/g, '-');

    return \`<div class="req-item \${srcCls}\${sel}" data-id="\${esc(r.id)}" onclick="selectRequest('\${esc(r.id)}')">
      <span class="method-badge \${mClass}">\${esc(r.method)}</span>
      <span class="req-url" title="\${esc(r.url)}">\${esc(r.url)}</span>
      <span class="req-meta">
        <span class="req-status-row">
          <span class="source-letter \${sLetterCls}">\${sLetter}</span>
          <span class="status-badge \${sClass}">\${r.statusCode || '…'}</span>
        </span>
        <span>\${dur}</span>
        <span>\${size}</span>
      </span>
    </div>\`;
  }).join('');

  listEl.innerHTML = html;

  if (atBottom) {
    listEl.scrollTop = listEl.scrollHeight;
  }
}

// ── Select request ────────────────────────────────────────────────────────────
async function selectRequest(id) {
  selectedId = id;

  renderList();

  detailEmpty.style.display = 'none';
  detailPanel.style.display = 'flex';
  detailPanel.style.flexDirection = 'column';
  detailPanel.style.overflow = 'hidden';
  detailScroll.innerHTML = '<div style="padding:20px;color:var(--text3)">Loading…</div>';

  try {
    const r = await fetch('/@api/requests/' + encodeURIComponent(id));

    if (!r.ok) {
      showDetailEmpty();

      return;
    }

    const entry = await r.json();

    renderDetail(entry);
  } catch(e) {
    showDetailEmpty();
  }
}
window.selectRequest = selectRequest;

function showDetailEmpty() {
  detailPanel.style.display = 'none';
  detailEmpty.style.display = 'flex';
}

function renderDetail(e) {
  currentEntry = e;

  const sClass = statusClass(e.statusCode);
  const src = sourceInfo(e.source);

  detailInfo.innerHTML = \`
    <div class="info-item"><div class="info-label">Method</div><div class="info-value"><span class="method-badge \${methodClass(e.method)}">\${esc(e.method)}</span></div></div>
    <div class="info-item"><div class="info-label">Status</div><div class="info-value"><span class="status-badge \${sClass}">\${e.statusCode || '—'}</span></div></div>
    <div class="info-item"><div class="info-label">Source</div><div class="info-value"><span class="source-chip \${src.cls}">\${src.title}</span></div></div>
    <div class="info-item"><div class="info-label">Duration</div><div class="info-value">\${e.duration != null ? formatDur(e.duration) : '—'}</div></div>
    <div class="info-item"><div class="info-label">Request</div><div class="info-value">\${formatBytes(e.requestBodySize||0)}</div></div>
    <div class="info-item"><div class="info-label">Response</div><div class="info-value">\${formatBytes(e.responseBodySize||0)}</div></div>
    <div class="info-item"><div class="info-label">Time</div><div class="info-value" style="font-size:11px">\${new Date(e.timestamp).toLocaleTimeString()}</div></div>
  \`;

  detailUrl.innerHTML = \`<span class="info-url-text" title="\${esc(e.url)}">\${esc(e.url)}</span><button class="section-btn" onclick="copyUrl(this)">Copy link</button>\`;

  const sections = [
    makeHeadersSection('Request Headers', e.requestHeaders, 'request'),
    makeBodySection('Request Body', e.requestBody, e.requestContentType, e.requestBodyTruncated, e.requestBodySize, 'request'),
    makeHeadersSection('Response Headers', e.responseHeaders, 'response'),
    makeBodySection('Response Body', e.responseBody, e.responseContentType, e.responseBodyTruncated, e.responseBodySize, 'response'),
  ];

  detailScroll.innerHTML = sections.join('');
}

function makeHeadersSection(title, headers, type) {
  const entries = Object.entries(headers || {}).filter(([,v]) => v != null);
  const rows = entries.map(([k,v]) => \`<tr><td>\${esc(k)}</td><td>\${esc(Array.isArray(v) ? v.join(', ') : String(v))}</td></tr>\`).join('');
  const actionsHtml = entries.length ? \`<div class="section-actions"><button class="section-btn" onclick="event.stopPropagation();copyHeaders('\${type}',this)">Copy</button></div>\` : '';

  return \`<div class="detail-section">
    <div class="detail-section-hdr" onclick="toggleSection(this)">
      <span class="toggle">▾</span>
      <span class="section-title">\${title}</span>
      <span class="section-badge">\${entries.length}</span>
      \${actionsHtml}
    </div>
    <div class="detail-section-body">
      <table class="kv-table">\${rows}</table>
    </div>
  </div>\`;
}

function makeBodySection(title, b64, contentType, truncated, size, type) {
  let bodyHtml = '';
  const ct = (contentType || '').toLowerCase().split(';')[0].trim();
  const isText = ct.includes('json') || ct.startsWith('text/') || ct.includes('/javascript') || ct === 'application/xml' || ct === 'application/x-www-form-urlencoded';

  if (!b64 && !truncated) {
    bodyHtml = '<div class="body-binary">No body</div>';
  } else if (truncated) {
    bodyHtml = \`<div class="body-binary">Body too large to capture (\${formatBytes(size)})</div>\`;
  } else if (b64) {
    if (ct.includes('json') || ct.includes('/javascript') || ct === 'text/plain') {
      const text = decodeTextBody(b64);

      if (ct.includes('json')) {
        try {
          bodyHtml = \`<pre class="body-content json">\${syntaxHighlightJson(text)}</pre>\`;
        } catch {
          bodyHtml = \`<pre class="body-content">\${esc(text)}</pre>\`;
        }
      } else {
        bodyHtml = \`<pre class="body-content">\${esc(text)}</pre>\`;
      }
    } else if (ct.startsWith('text/')) {
      bodyHtml = \`<pre class="body-content">\${esc(decodeTextBody(b64))}</pre>\`;
    } else if (ct.startsWith('image/') && size < 1024*1024) {
      bodyHtml = \`<img class="body-image" src="data:\${esc(ct)};base64,\${b64}" alt="image"/>\`;
    } else if (ct === 'application/x-www-form-urlencoded') {
      const params = new URLSearchParams(decodeTextBody(b64));
      const rows = [...params.entries()].map(([k,v]) => \`<tr><td>\${esc(k)}</td><td>\${esc(v)}</td></tr>\`).join('');

      bodyHtml = \`<table class="kv-table">\${rows}</table>\`;
    } else {
      bodyHtml = \`<div class="body-binary">Binary data — \${formatBytes(size)} (\${esc(ct || 'unknown type')})</div>\`;
    }
  }

  const copyBtn = b64 && isText ? \`<button class="section-btn" onclick="event.stopPropagation();copyBody('\${type}',this)">Copy</button>\` : '';
  const saveBtn = b64 ? \`<button class="section-btn" onclick="event.stopPropagation();saveBody('\${type}')">Save</button>\` : '';
  const actionsHtml = (copyBtn || saveBtn) ? \`<div class="section-actions">\${copyBtn}\${saveBtn}</div>\` : '';
  const note = truncated ? \`<div class="truncated-note">⚠ Body was larger than the capture limit (\${formatBytes(CAPTURE_LIMIT)})</div>\` : '';

  return \`<div class="detail-section">
    <div class="detail-section-hdr" onclick="toggleSection(this)">
      <span class="toggle">▾</span>
      <span class="section-title">\${title}</span>
      \${size ? \`<span class="section-badge">\${formatBytes(size)}</span>\` : ''}
      \${actionsHtml}
    </div>
    <div class="detail-section-body">\${bodyHtml}\${note}</div>
  </div>\`;
}

window.toggleSection = function(hdr) {
  const body = hdr.nextElementSibling;
  const toggle = hdr.querySelector('.toggle');

  if (body.classList.toggle('collapsed')) {
    toggle.textContent = '▸';
  } else {
    toggle.textContent = '▾';
  }
};

async function clearAll() {
  await fetch('/@api/requests', { method: 'DELETE' });

  allRequests = [];
  filteredRequests = [];
  selectedId = null;

  showDetailEmpty();
  renderList();
  updateStats({ total: 0, memoryUsage: 0, maxMemory: 1024*1024*1024 });
}
window.clearAll = clearAll;

// ── JSON syntax highlighting ──────────────────────────────────────────────────
function syntaxHighlightJson(str) {
  try {
    const parsed = JSON.parse(str);

    str = JSON.stringify(parsed, null, 2);
  } catch { /* use as-is */ }

  return str.replace(/("(\\\\u[a-zA-Z0-9]{4}|\\\\[^u]|[^\\\\"])*"\\s*:?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g, function(m) {
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
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function decodeTextBody(b64) {
  const bytes = Uint8Array.from(atob(b64), function(c) { return c.charCodeAt(0); });

  return new TextDecoder('utf-8').decode(bytes);
}

function sourceInfo(source) {
  if (source === 'proxy') {
    return { cls: 'src-proxy', title: 'Backend (live)' };
  }

  if (source === 'proxy-cache') {
    return { cls: 'src-proxy-cache', title: 'Backend (cached)' };
  }

  return { cls: 'src-local', title: 'Local (dev server)' };
}

function sourceLetter(source) {
  if (source === 'proxy') {
    return 'P';
  }

  if (source === 'proxy-cache') {
    return 'C';
  }

  return 'L';
}

// ── Copy / Save ───────────────────────────────────────────────────────────────
function clipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (!btn) {
      return;
    }

    const orig = btn.textContent;

    btn.textContent = '✓';
    btn.style.color = 'var(--green)';
    setTimeout(() => {
      btn.textContent = orig;
      btn.style.color = '';
    }, 1500);
  }).catch(() => {});
}

function copyUrl(btn) {
  clipboard(currentEntry ? currentEntry.url : '', btn);
}
window.copyUrl = copyUrl;

function copyHeaders(type, btn) {
  const h = type === 'request' ? (currentEntry && currentEntry.requestHeaders) : (currentEntry && currentEntry.responseHeaders);

  if (!h) {
    return;
  }

  const text = Object.entries(h).filter(([,v]) => v != null).map(([k,v]) => k + ': ' + (Array.isArray(v) ? v.join(', ') : v)).join('\\n');

  clipboard(text, btn);
}
window.copyHeaders = copyHeaders;

function copyBody(type, btn) {
  const b64 = type === 'request' ? (currentEntry && currentEntry.requestBody) : (currentEntry && currentEntry.responseBody);

  if (!b64) {
    return;
  }

  try {
    clipboard(decodeTextBody(b64), btn);
  } catch(e) {}
}
window.copyBody = copyBody;

function saveBody(type) {
  const b64 = type === 'request' ? (currentEntry && currentEntry.requestBody) : (currentEntry && currentEntry.responseBody);
  const ct = type === 'request' ? (currentEntry && currentEntry.requestContentType) : (currentEntry && currentEntry.responseContentType);

  if (!b64) {
    return;
  }

  downloadB64(b64, type + '-body.' + fileExt(ct));
}
window.saveBody = saveBody;

function downloadB64(b64, filename) {
  try {
    const bytes = Uint8Array.from(atob(b64), function(c) { return c.charCodeAt(0); });
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
  } catch(e) {}
}

function fileExt(ct) {
  ct = ((ct || '').split(';')[0]).trim().toLowerCase();

  var map = {
    'application/json': 'json', 'text/html': 'html', 'text/css': 'css',
    'text/javascript': 'js', 'application/javascript': 'js', 'text/plain': 'txt',
    'text/xml': 'xml', 'application/xml': 'xml', 'image/png': 'png',
    'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/svg+xml': 'svg',
    'image/webp': 'webp', 'application/pdf': 'pdf', 'application/zip': 'zip',
    'application/x-www-form-urlencoded': 'txt', 'application/octet-stream': 'bin',
  };

  return map[ct] || 'bin';
}

function formatBytes(b) {
  b = b || 0;

  if (b < 1024) {
    return b + ' B';
  }

  if (b < 1024*1024) {
    return (b/1024).toFixed(1) + ' KB';
  }

  if (b < 1024*1024*1024) {
    return (b/(1024*1024)).toFixed(1) + ' MB';
  }

  return (b/(1024*1024*1024)).toFixed(2) + ' GB';
}

function formatDur(ms) {
  if (ms < 1000) {
    return ms + 'ms';
  }

  return (ms/1000).toFixed(2) + 's';
}

function methodClass(m) {
  const map = { GET:'m-GET', POST:'m-POST', PUT:'m-PUT', PATCH:'m-PATCH', DELETE:'m-DELETE', HEAD:'m-HEAD', OPTIONS:'m-OPTIONS' };

  return map[m] || 'm-other';
}

function statusClass(s) {
  if (!s) {
    return 's-pending';
  }

  const c = Math.floor(s / 100);

  return ['','','s-2xx','s-3xx','s-4xx','s-5xx'][c] || '';
}

// ── Polling ───────────────────────────────────────────────────────────────────
fetchList();
setInterval(fetchList, 2000);

})();
</script>
</body>
</html>`;
}
