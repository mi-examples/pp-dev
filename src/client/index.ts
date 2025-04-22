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

interface InfoPopupOptions {
  title: string;
  content: string;
  style?: string;
  className?: string;
  duration?: number;
  onClose?: () => void;
  type?: 'success' | 'danger' | 'info' | 'warning';
}

let activePopups = 0;
const POPUP_OFFSET = 10;
const POPUP_HEIGHT = 100;
const ANIMATION_DURATION = 300;

function createPopupElement(opts: InfoPopupOptions): HTMLDivElement {
  const $popup = document.createElement('div');

  $popup.classList.add('pp-dev-info-namespace');

  const typeClass = opts.type ? `pp-dev-info__popup--${opts.type}` : '';

  const template = `
    <div class="pp-dev-info__popup ${typeClass} ${opts.className || ''}" style="${opts.style || ''}">
      <div class="pp-dev-info__popup-title">
        <div class="pp-dev-info__popup-title-text">${opts.title}</div>
        <div class="pp-dev-info__popup-title-close">
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            stroke="currentColor"
            stroke-width="1.5"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M18 6L6 18"></path>
            <path d="M6 6l12 12"></path>
          </svg>
        </div>
      </div>
      <div class="pp-dev-info__popup-content">${opts.content}</div>
      <div class="pp-dev-info__popup-progress"></div>
    </div>
  `;

  $popup.innerHTML = template;

  return $popup;
}

function updatePopupPositions() {
  const popups = document.querySelectorAll(
    '.pp-dev-info-namespace:not(.pp-dev-info)'
  );
  const $devPanel = document.querySelector('.pp-dev-info');
  
  // Update popup positions
  popups.forEach((popup, index) => {
    const top = POPUP_OFFSET + (index * (POPUP_HEIGHT + POPUP_OFFSET));
    (popup as HTMLElement).style.top = `${top}px`;
  });

  // Ensure dev panel stays at the bottom
  if ($devPanel) {
    ($devPanel as HTMLElement).style.top = 'auto';
    ($devPanel as HTMLElement).style.bottom = '0';
  }
}

function animatePopup($popup: HTMLDivElement, type: 'enter' | 'exit') {
  return new Promise<void>((resolve) => {
    const $popupContent = $popup.querySelector('.pp-dev-info-namespace');

    if (!$popupContent) {
      return resolve();
    }

    if (type === 'enter') {
      $popupContent.classList.add('entering');

      requestAnimationFrame(() => {
        $popupContent.classList.remove('entering');

        resolve();
      });
    } else {
      $popupContent.classList.add('exiting');

      setTimeout(() => {
        $popupContent.classList.remove('exiting');

        resolve();
      }, ANIMATION_DURATION);
    }
  });
}

function infoPopup(opts: InfoPopupOptions) {
  const $popup = createPopupElement(opts);
  const $closeButton = $popup.querySelector('.pp-dev-info__popup-title-close');
  const $progressBar = $popup.querySelector('.pp-dev-info__popup-progress');

  const removePopup = async () => {
    await animatePopup($popup, 'exit');

    $popup.remove();

    activePopups--;

    updatePopupPositions();

    opts.onClose?.();
  };

  $closeButton?.addEventListener('click', removePopup);
  document.body.appendChild($popup);

  // Position the popup
  activePopups++;
  updatePopupPositions();

  // Animate entrance
  animatePopup($popup, 'enter');

  const duration = opts.duration ?? 10000;

  if (duration > 0) {
    let remainingTime = duration;
    let lastUpdate = Date.now();
    let isVisible = true;

    // Update progress bar
    const updateProgress = () => {
      if (!isVisible) {
        return;
      }

      const now = Date.now();
      const elapsed = now - lastUpdate;
      remainingTime -= elapsed;
      lastUpdate = now;

      if (remainingTime <= 0) {
        removePopup();

        return;
      }

      const progress = (remainingTime / duration) * 100;
      if ($progressBar) {
        ($progressBar as HTMLElement).style.width = `${progress}%`;
      }

      requestAnimationFrame(updateProgress);
    };

    // Handle visibility change
    document.addEventListener('visibilitychange', () => {
      isVisible = !document.hidden;

      if (isVisible) {
        lastUpdate = Date.now();
        requestAnimationFrame(updateProgress);
      }
    });

    // Start progress bar animation
    requestAnimationFrame(updateProgress);
  }
}

if (import.meta.hot) {
  const { hot } = import.meta;

  const CLOSED_CLASS = 'closed';
  const CLOSED_CLASS_STORAGE_KEY = 'pp-dev-info-closed';

  hot.on('redirect', (data: { url: string }) => {
    window.location.href = data.url;
  });

  hot.on('client:config:update', (data: { config: { [key: string]: any } }) => {
    if (typeof data.config?.canSync === 'boolean') {
      if (data.config.canSync) {
        const $syncButton = document.getElementById('sync-template') as HTMLButtonElement | null;

        if ($syncButton) {
          $syncButton.disabled = false;
          $syncButton.classList.remove('disabled');
          $syncButton.title = 'Sync template';
        }
      } else {
        const $syncButton = document.getElementById('sync-template') as HTMLButtonElement | null;

        if ($syncButton) {
          $syncButton.disabled = true;
          $syncButton.classList.add('disabled');
          $syncButton.title = 'Sync is unavailable on this instance';
        }
      }
    }
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

  const $syncButton = document.getElementById('sync-template') as HTMLButtonElement | null;

  if ($syncButton) {
    hot.on(
      'template:sync:response',
      (
        payload:
          | { syncedAt: string; currentHash: string; backupFilename: string }
          | { error: string; config?: { [p: string]: any }; refresh?: boolean },
      ) => {
        $syncButton.classList.remove('syncing');

        if ('error' in payload && typeof payload.error !== 'undefined') {
          infoPopup({
            title: 'Sync error',
            content: payload.error,
            className: 'pp-dev-info__popup--danger',
          });

          if (payload.refresh) {
            setTimeout(() => {
              window.location.reload();
            });
          } else {
            $syncButton.disabled = true;
            $syncButton.classList.add('disabled');
            $syncButton.title = 'Sync is unavailable on this instance';
          }
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
