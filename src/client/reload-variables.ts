import type { ViteHotContext } from 'vite/types/hot.js';
import type { InfoPopupOptions } from './popup.js';

type PageVariablesReloadResponsePayload = { ok: true; count: number; skipped: boolean } | { error: string };

export interface ReloadVariablesDeps {
  infoPopup: (opts: InfoPopupOptions) => { close: () => void };
  /** Reloads the page once the variables are reloaded; `window.location.reload` by default. */
  reload?: () => void;
}

/**
 * Wires the dev panel's "Reload variables" action to the dev server, and returns what starts it.
 *
 * Like the sync button, it refuses to start while the dev server is not connected: both transports
 * keep a message until the socket is back, so the "Reloading variables" popup, which stays until
 * an answer comes, stayed until a reconnect — and the page then reloaded on its own, unasked. A
 * connection lost while waiting ends the wait the same way.
 */
export function initReloadVariables(
  hot: Pick<ViteHotContext, 'on' | 'send'> & { isConnected?: () => boolean },
  deps: ReloadVariablesDeps,
): () => void {
  const reload = deps.reload ?? (() => window.location.reload());
  // As the sync button takes it: Vite's connection is open until reported lost; the `pp-dev next`
  // transport says itself whether its socket is open.
  let connected = true;
  let pending: { close: () => void } | null = null;
  const isConnected = () => connected && (hot.isConnected?.() ?? true);

  const endWait = () => {
    pending?.close();
    pending = null;
  };

  hot.on('vite:ws:connect', () => {
    connected = true;
  });

  hot.on('vite:ws:disconnect', () => {
    connected = false;

    if (!pending) {
      return;
    }

    endWait();
    deps.infoPopup({
      title: 'Reload variables interrupted',
      content: 'The connection to the dev server was lost. Try again once it is back.',
      type: 'warning',
    });
  });

  hot.on('page-variables:reload:response', (payload: PageVariablesReloadResponsePayload) => {
    endWait();

    if ('error' in payload) {
      deps.infoPopup({
        title: 'Reload variables error',
        content: payload.error,
        type: 'danger',
      });

      return;
    }

    if (payload.skipped) {
      deps.infoPopup({
        title: 'Nothing to reload',
        content: 'This page has no template variables to refresh.',
        type: 'warning',
      });

      return;
    }

    deps.infoPopup({
      title: 'Variables reloaded',
      content: `Refetched ${payload.count} variable(s) from MI. Reloading the page…`,
      type: 'success',
      duration: 1200,
    });

    setTimeout(reload, 600);
  });

  return () => {
    if (!isConnected()) {
      deps.infoPopup({
        title: 'No connection',
        content: 'The dev server is not connected. Check that it is running, then try again.',
        type: 'warning',
      });

      return;
    }

    endWait();
    pending = deps.infoPopup({
      title: 'Reloading variables',
      content: 'Refetching live values from MI…',
      type: 'info',
      duration: 0,
    });

    hot.send('page-variables:reload', {});
  };
}
