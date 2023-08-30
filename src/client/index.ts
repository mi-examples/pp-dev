/// <reference types="vite/client" />
import './assets/css/client.scss';
import './index.html';

function checkLocalStorage() {
  try {
    localStorage.setItem('test', 'test');
    localStorage.removeItem('test');

    return true;
  } catch (e) {
    return false;
  }
}

function setStorageItem(key: string, value: string) {
  if (checkLocalStorage()) {
    localStorage.setItem(key, value);
  }
}

function getStorageItem(key: string) {
  if (checkLocalStorage()) {
    return localStorage.getItem(key);
  }

  return null;
}

function removeStorageItem(key: string) {
  if (checkLocalStorage()) {
    localStorage.removeItem(key);
  }
}

function infoPopup(opts: { title: string; content: string; style?: string; className?: string }) {
  const template = `
    <div class="pp-dev-info__popup ${opts.className || ''}" style="${opts.style || ''}">
      <div class="pp-dev-info__popup-title">
        <div class="pp-dev-info__popup-title-text">${opts.title}</div>
        <div class="pp-dev-info__popup-title-close">
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6L6 18"></path>
            <path d="M6 6l12 12"></path>
          </svg>
        </div>
      </div>
      <div class="pp-dev-info__popup-content">${opts.content}</div>
    </div>
    `;

  const $popup = document.createElement('div');

  $popup.classList.add('pp-dev-info-namespace');
  $popup.innerHTML = template;

  $popup.querySelector('.pp-dev-info__popup-title-close')?.addEventListener('click', () => {
    $popup.remove();
  });

  document.body.appendChild($popup);

  setTimeout(() => {
    $popup.remove();
  }, 10000);
}

if (import.meta.hot) {
  const { hot } = import.meta;

  const CLOSED_CLASS = 'closed';
  const CLOSED_CLASS_STORAGE_KEY = 'pp-dev-info-closed';

  hot.on('redirect', (data: { url: string }) => {
    window.location.href = data.url;
  });

  let isClosed = getStorageItem(CLOSED_CLASS_STORAGE_KEY) === 'true' || false;

  const $infoPanel = document.querySelector('.pp-dev-info');

  const $minimizeButtonWrap = document.querySelector('.pp-dev-info__wrap-btn');
  const $minimizeButtonSVG = $minimizeButtonWrap?.querySelector('svg');

  if ($infoPanel && $minimizeButtonWrap && $minimizeButtonSVG) {
    if (isClosed) {
      $infoPanel.classList.add(CLOSED_CLASS);
      $minimizeButtonSVG.classList.add(CLOSED_CLASS);
    }

    $minimizeButtonWrap.addEventListener('click', (e) => {
      e.preventDefault();

      $infoPanel.classList.toggle(CLOSED_CLASS);
      $minimizeButtonSVG.classList.toggle(CLOSED_CLASS);

      isClosed = !isClosed;

      setStorageItem(CLOSED_CLASS_STORAGE_KEY, isClosed ? 'true' : 'false');
    });
  }

  const $syncButton = document.getElementById('sync-template');

  if ($syncButton) {
    hot.on(
      'template:sync:response',
      (payload: { syncedAt: string; currentHash: string; backupFilename: string } | { error: string }) => {
        $syncButton.classList.remove('syncing');

        if ('error' in payload && typeof payload.error !== 'undefined') {
          infoPopup({
            title: 'Sync error',
            content: payload.error,
            className: 'pp-dev-info__popup--danger',
          });
        } else if ('syncedAt' in payload && typeof payload.syncedAt !== 'undefined') {
          infoPopup({
            title: 'Sync success',
            content: `Synced at ${new Date(payload.syncedAt).toLocaleString()}.<br />Backup filename: ${
              payload.backupFilename
            }`,
            className: 'pp-dev-info__popup--success',
          });
        }
      },
    );

    $syncButton.addEventListener('click', (ev) => {
      ev.preventDefault();

      $syncButton.classList.add('syncing');

      hot.send('template:sync', {});
    });
  }
}
