/// <reference types="vite/client" />
import './assets/css/client.scss';
import './index.html';

if (import.meta.hot) {
  const { hot } = import.meta;

  hot.on('redirect', (data: { url: string }) => {
    window.location.href = data.url;
  });

  const syncButton = document.getElementById('sync-template');

  const clientWrapButton = document.querySelector('.pp-dev-info__wrap-btn svg');
  const bottomInfoPanel = document.querySelector('.pp-dev-info');

  if (clientWrapButton && bottomInfoPanel) {
    clientWrapButton.addEventListener('click', (e) => {
      e.preventDefault();

      bottomInfoPanel.classList.toggle('closed');
      clientWrapButton.classList.toggle('closed');
    });
  }

  if (syncButton) {
    hot.on('template:sync:response', (payload) => {
      syncButton.classList.remove('syncing');

      console.log(payload);
    });

    syncButton.addEventListener('click', (ev) => {
      ev.preventDefault();

      syncButton.classList.add('syncing');

      hot.send('template:sync', {});
    });
  }
}
