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
    hot.on('template:sync:response', (payload) => {
      $syncButton.classList.remove('syncing');

      console.log(payload);
    });

    $syncButton.addEventListener('click', (ev) => {
      ev.preventDefault();

      $syncButton.classList.add('syncing');

      hot.send('template:sync', {});
    });
  }
}
