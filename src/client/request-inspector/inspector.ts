// The Request Inspector page (`/@pp-dev/inspector`): lists what went through the dev server and
// shows a request's headers and bodies. main.ts starts it on request-inspector.html.
import { getStoredTheme, setTheme, applyTheme, type ThemeChoice } from '../theme.js';
import { decodeBase64, decodeTextBody, fileExt, formatBytes } from './format.js';
import {
  renderDetailInfoHtml,
  renderDetailSectionsHtml,
  renderDetailUrlHtml,
  renderListHtml,
  type RequestEntry,
  type RequestSummary,
  type Side,
} from './render.js';

/** Value of the user filter for requests sent as the original user (a saved user's name can't start with "@"). */
const ORIGINAL_USER = '@original';
const DEFAULT_CAPTURE_LIMIT = 10 * 1024 * 1024;

interface ListResponse {
  requests?: RequestSummary[];
  total: number;
  memoryUsage: number;
  maxMemory: number;
}

export interface InspectorOptions {
  /** How often the list is fetched again. */
  pollIntervalMs?: number;
}

/** Starts the page on the current document; returns a function that stops it (polling and listeners). */
export function startInspector({ pollIntervalMs = 2000 }: InspectorOptions = {}): () => void {
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

  const captureLimit = Number(document.body.dataset.captureLimit) || DEFAULT_CAPTURE_LIMIT;
  const listEl = byId<HTMLDivElement>('req-list');
  const detailEmpty = byId<HTMLDivElement>('detail-empty');
  const detailPanel = byId<HTMLDivElement>('detail-panel');
  const detailInfo = byId<HTMLDivElement>('detail-info');
  const detailUrl = byId<HTMLDivElement>('detail-url');
  const detailScroll = byId<HTMLDivElement>('detail-scroll');
  const filterBar = byId<HTMLDivElement>('filter-bar');
  const searchInput = byId<HTMLInputElement>('search-input');
  const methodSelect = byId<HTMLSelectElement>('method-select');
  const statusSelect = byId<HTMLSelectElement>('status-select');
  const sourceSelect = byId<HTMLSelectElement>('source-select');
  const userSelect = byId<HTMLSelectElement>('user-select');
  const themeSwitch = byId<HTMLDivElement>('theme-switch');

  let allRequests: RequestSummary[] = [];
  let filteredRequests: RequestSummary[] = [];
  let selectedId: string | null = null;
  let currentEntry: RequestEntry | null = null;

  // ── Theme (Auto/Dark/Light) ────────────────────────────────────────────────
  // The page's <head> already set the stored theme before first paint; this keeps the buttons in
  // step. Shared with the dev panel and the Variables Editor (see ../theme.ts).
  const showTheme = (theme: ThemeChoice) => {
    applyTheme(theme);

    for (const button of Array.from(themeSwitch.children) as HTMLElement[]) {
      const isActive = button.dataset.themeChoice === theme;

      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    }
  };

  // ── List ───────────────────────────────────────────────────────────────────
  const updateStats = (data: Pick<ListResponse, 'total' | 'memoryUsage' | 'maxMemory'>) => {
    const pct = data.maxMemory > 0 ? Math.min(100, (data.memoryUsage / data.maxMemory) * 100) : 0;

    byId('req-count').textContent = data.total + ' request' + (data.total !== 1 ? 's' : '');
    byId('mem-fill').style.width = pct + '%';
    byId('mem-text').textContent = formatBytes(data.memoryUsage) + ' / ' + formatBytes(data.maxMemory);
  };

  // The user filter only shows up once a request was sent as a saved user.
  const updateUserOptions = () => {
    const names = Array.from(new Set(allRequests.map((r) => r.user).filter((u): u is string => Boolean(u)))).sort();
    const current = userSelect.value;

    userSelect.style.display = names.length ? '' : 'none';
    userSelect.replaceChildren(
      new Option('All users', ''),
      new Option('Original', ORIGINAL_USER),
      ...names.map((name) => new Option(name, name)),
    );
    userSelect.value = current === ORIGINAL_USER || names.includes(current) ? current : '';
  };

  const renderList = () => {
    const atBottom = listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 16;

    listEl.innerHTML = renderListHtml(filteredRequests, selectedId);

    if (atBottom && filteredRequests.length) {
      listEl.scrollTop = listEl.scrollHeight;
    }
  };

  const applyFilter = () => {
    const search = searchInput.value.toLowerCase();
    const method = methodSelect.value;
    const status = statusSelect.value;
    const source = sourceSelect.value;
    const user = userSelect.value;

    filteredRequests = allRequests.filter(
      (r) =>
        !(user && (r.user || ORIGINAL_USER) !== user) &&
        !(method && r.method !== method) &&
        !(status && !String(r.statusCode || '').startsWith(status)) &&
        !(source && r.source !== source) &&
        !(search && !r.url.toLowerCase().includes(search)),
    );

    renderList();
  };

  const showDetailEmpty = () => {
    detailPanel.style.display = 'none';
    detailEmpty.style.display = 'flex';
  };

  const fetchList = async () => {
    try {
      const data = (await (await fetch('/@api/requests')).json()) as ListResponse;

      allRequests = data.requests || [];
      updateStats(data);
      updateUserOptions();
      applyFilter();

      if (selectedId && !allRequests.find((r) => r.id === selectedId)) {
        selectedId = null;
        showDetailEmpty();
      }
    } catch {
      // The dev server is restarting; the next poll tries again.
    }
  };

  // ── Detail ─────────────────────────────────────────────────────────────────
  const selectRequest = async (id: string) => {
    selectedId = id;
    renderList();

    detailEmpty.style.display = 'none';
    detailPanel.style.display = 'flex';
    detailPanel.style.flexDirection = 'column';
    detailPanel.style.overflow = 'hidden';
    detailScroll.innerHTML = '<div style="padding:20px;color:var(--text3)">Loading…</div>';

    try {
      const response = await fetch('/@api/requests/' + encodeURIComponent(id));

      if (!response.ok) {
        showDetailEmpty();

        return;
      }

      currentEntry = (await response.json()) as RequestEntry;
      detailInfo.innerHTML = renderDetailInfoHtml(currentEntry);
      detailUrl.innerHTML = renderDetailUrlHtml(currentEntry);
      detailScroll.innerHTML = renderDetailSectionsHtml(currentEntry, captureLimit);
    } catch {
      showDetailEmpty();
    }
  };

  const toggleSection = (header: HTMLElement) => {
    const body = header.nextElementSibling;
    const toggle = header.querySelector('.toggle');

    if (body && toggle) {
      toggle.textContent = body.classList.toggle('collapsed') ? '▸' : '▾';
    }
  };

  const clearAll = async () => {
    await fetch('/@api/requests', { method: 'DELETE' });

    allRequests = [];
    filteredRequests = [];
    selectedId = null;

    showDetailEmpty();
    renderList();
    updateStats({ total: 0, memoryUsage: 0, maxMemory: 1024 * 1024 * 1024 });
  };

  // ── Copy / Save ────────────────────────────────────────────────────────────
  const clipboard = (text: string, button: HTMLElement) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        const label = button.textContent;

        button.textContent = '✓';
        button.style.color = 'var(--green)';
        setTimeout(() => {
          button.textContent = label;
          button.style.color = '';
        }, 1500);
      })
      .catch(() => {});
  };

  const copyHeaders = (type: Side, button: HTMLElement) => {
    const headers = type === 'request' ? currentEntry?.requestHeaders : currentEntry?.responseHeaders;

    if (!headers) {
      return;
    }

    const text = Object.entries(headers)
      .filter(([, v]) => v != null)
      .map(([k, v]) => k + ': ' + (Array.isArray(v) ? v.join(', ') : String(v)))
      .join('\n');

    clipboard(text, button);
  };

  const bodyOf = (type: Side) => (type === 'request' ? currentEntry?.requestBody : currentEntry?.responseBody);

  const copyBody = (type: Side, button: HTMLElement) => {
    const b64 = bodyOf(type);

    if (!b64) {
      return;
    }

    try {
      clipboard(decodeTextBody(b64), button);
    } catch {
      // Not text after all.
    }
  };

  const saveBody = (type: Side) => {
    const b64 = bodyOf(type);
    const contentType = type === 'request' ? currentEntry?.requestContentType : currentEntry?.responseContentType;

    if (!b64) {
      return;
    }

    try {
      const url = URL.createObjectURL(new Blob([decodeBase64(b64) as BlobPart]));
      const link = document.createElement('a');

      link.href = url;
      link.download = type + '-body.' + fileExt(contentType);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      // Not valid base64.
    }
  };

  // ── Events ─────────────────────────────────────────────────────────────────
  // One handler for the whole page: list items carry `data-id`, buttons `data-action` (and
  // `data-type` for request/response), the theme buttons `data-theme-choice`.
  const onClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    const themeButton = target.closest<HTMLElement>('[data-theme-choice]');

    if (themeButton) {
      const theme = themeButton.dataset.themeChoice as ThemeChoice;

      setTheme(theme);
      showTheme(theme);

      return;
    }

    const actionEl = target.closest<HTMLElement>('[data-action]');
    const type = actionEl?.dataset.type as Side;

    switch (actionEl?.dataset.action) {
      case 'clear':
        void clearAll();

        return;
      case 'copy-url':
        clipboard(currentEntry?.url ?? '', actionEl);

        return;
      case 'copy-headers':
        copyHeaders(type, actionEl);

        return;
      case 'copy-body':
        copyBody(type, actionEl);

        return;
      case 'save-body':
        saveBody(type);

        return;
      case 'toggle-section':
        toggleSection(actionEl);

        return;
    }

    const item = target.closest<HTMLElement>('.req-item');

    if (item?.dataset.id) {
      void selectRequest(item.dataset.id);
    }
  };

  document.addEventListener('click', onClick);
  filterBar.addEventListener('input', applyFilter);
  filterBar.addEventListener('change', applyFilter);

  showTheme(getStoredTheme());
  void fetchList();

  const poll = setInterval(() => void fetchList(), pollIntervalMs);

  return () => {
    clearInterval(poll);
    document.removeEventListener('click', onClick);
    filterBar.removeEventListener('input', applyFilter);
    filterBar.removeEventListener('change', applyFilter);
  };
}
