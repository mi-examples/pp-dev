/// <reference types="vite/client" />

if (import.meta.hot) {
  import.meta.hot.on('redirect', (data: { url: string }) => {
    window.location.href = data.url;
  });
}
