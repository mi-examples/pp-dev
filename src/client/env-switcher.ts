/**
 * The dev panel's MI environment switcher (PP-4840 phase 4): with more than one environment in the
 * config, the environment's name becomes a list. A choice restarts the dev server in it, until pp-dev
 * stops; every tab of the server is told, and reloads once the server works with the chosen one.
 */
import type { ViteHotContext } from 'vite/types/hot.js';
import type { InfoPopupOptions } from './popup.js';
import type { ConfirmModalOptions } from './sync-button.js';
import type { EnvSwitchFailedPayload, EnvSwitchPayload, EnvironmentResponse } from '../shared/ws-messages.js';
import { DEFAULT_ENV_NAME } from '../shared/mi-environments.js';

export const ENVIRONMENT_API = '/@api/environment';

/** How often a tab asks whether the restarted server is up, and for how long. */
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 120_000;

/** The reload a page made for an environment the server answered in, once: see `reloadOnce`. */
export const MISMATCH_RELOAD_KEY = 'pp-dev:env-mismatch-reload';

export interface EnvSwitcherDeps {
  infoPopup: (opts: InfoPopupOptions) => unknown;
  confirmModal: (opts: ConfirmModalOptions) => Promise<boolean>;
  /** @default `window.location.reload` */
  reload?: () => void;
  /** @default `window.fetch` */
  fetch?: typeof fetch;
}

/** The text of an environment in the list. */
function describeChoice(choice: EnvironmentResponse['environments'][number]): string {
  return choice.name + (choice.protected ? ' (protected)' : '') + (choice.hasUrl ? '' : ' (no URL)');
}

export async function initEnvSwitcher(
  hot: Pick<ViteHotContext, 'on' | 'send'> & { isConnected?: () => boolean },
  $section: HTMLElement,
  deps: EnvSwitcherDeps,
): Promise<void> {
  const reload = deps.reload ?? (() => window.location.reload());
  const get = deps.fetch ?? ((input, init) => window.fetch(input, init));

  /**
   * The environment this tab knows the server in: the server's first answer, until then the page's
   * (its name in the panel; none for the default one).
   */
  const $name = $section.querySelector<HTMLElement>('.pp-dev-info__env');
  const pageEnv = $name?.textContent?.trim() || DEFAULT_ENV_NAME;
  const hiddenWithoutList = $section.classList.contains('pp-dev-info__env-section--none');
  let current = pageEnv;
  let $select: HTMLSelectElement | undefined;
  /** The choices the list shows, to tell when a restart brought others; `''` with no list. */
  let shown = '';
  /** Between `vite:ws:disconnect` and the next `vite:ws:connect`. */
  let disconnected = false;

  /**
   * A page served in one environment by a server that works with another now (a switch it missed)
   * reloads: a Sync from it would go to the other one. Once per pair, should the page's name and the
   * server's ever not agree for good.
   */
  const reloadOnce = (from: string, to: string): boolean => {
    const mark = `${from} > ${to}`;

    try {
      if (window.sessionStorage.getItem(MISMATCH_RELOAD_KEY) === mark) {
        return false;
      }

      window.sessionStorage.setItem(MISMATCH_RELOAD_KEY, mark);
    } catch {
      // No storage: no way to tell a second reload from the first.
      return false;
    }

    reload();

    return true;
  };

  const ask = async (): Promise<EnvironmentResponse | undefined> => {
    try {
      const response = await get(ENVIRONMENT_API, { cache: 'no-store' });

      return response.ok ? ((await response.json()) as EnvironmentResponse) : undefined;
    } catch {
      // Restarting, or a dev server older than the panel.
      return undefined;
    }
  };

  // One switch waited for at a time. A run is over once another starts or the wait stops: an answer
  // it was still awaiting then is dropped, not acted on.
  let waiting: string | undefined;
  let run = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  /** A failure this tab showed for the switch, from the server's answer before its message came. */
  let failureShown: string | undefined;

  const stopWaiting = () => {
    run++;
    waiting = undefined;
    clearTimeout(pollTimer);
    pollTimer = undefined;
  };

  const reset = () => {
    stopWaiting();

    if ($select) {
      $select.value = current;
      $select.disabled = false;
    }
  };

  const showFailure = (error: string) => {
    reset();
    deps.infoPopup({
      title: 'Environment switch failed',
      content: `The dev server stays in ${current}: ${error}`,
      type: 'danger',
    });
  };

  /**
   * The list in place of the name: with more than one environment, where the server can restart.
   * Made again when a restart (a config change) brings other choices, and the name back without any.
   */
  const build = (data: EnvironmentResponse) => {
    const offers = Array.isArray(data.environments) && data.environments.length > 1 && data.canSwitch !== false;
    const choices = offers ? JSON.stringify(data.environments) : '';

    if (choices === shown) {
      return;
    }

    shown = choices;

    if (!offers) {
      if ($select && $name) {
        $select.replaceWith($name);
        $section.classList.toggle('pp-dev-info__env-section--none', hiddenWithoutList);
      }

      $select = undefined;

      return;
    }

    const $list = document.createElement('select');

    $list.className = 'pp-dev-info__env-select';
    $list.title = 'MI environment: a choice restarts the dev server in it';
    $list.setAttribute('aria-label', 'MI environment');

    for (const choice of data.environments) {
      const $option = document.createElement('option');

      $option.value = choice.name;
      $option.textContent = describeChoice(choice);
      $option.disabled = !choice.hasUrl;
      $option.selected = choice.name === current;
      $list.append($option);
    }

    $list.disabled = waiting !== undefined;
    ($select ?? $name)?.replaceWith($list);
    $section.classList.remove('pp-dev-info__env-section--none');
    $select = $list;

    $list.addEventListener('change', async () => {
      const name = $list.value;

      if (name === current) {
        return;
      }

      const confirmed = await deps.confirmModal({
        title: 'Switch MI environment',
        content: `Restart the dev server in ${name}? Every tab of it reloads; the choice lasts until pp-dev stops.`,
        confirmText: `Switch to ${name}`,
        cancelText: 'Cancel',
      });

      if (!confirmed) {
        $list.value = current;

        return;
      }

      // Sent now, the request would wait for a reconnect with the list disabled, and restart the
      // server whenever that happens. Say so instead, as the Sync button does.
      if (disconnected || hot.isConnected?.() === false) {
        $list.value = current;
        deps.infoPopup({
          title: 'No connection',
          content: 'The dev server is not connected. Check that it is running, then choose again.',
          type: 'warning',
        });

        return;
      }

      $list.disabled = true;
      failureShown = undefined;
      hot.send('env:switch', { name } satisfies EnvSwitchPayload);
    });
  };

  /** Reloads once the dev server answers with `name`: the restarted one. */
  const waitFor = (name: string) => {
    stopWaiting();

    const thisRun = run;
    const startedAt = Date.now();

    waiting = name;

    const poll = async () => {
      const data = await ask();

      if (thisRun !== run) {
        return;
      }

      if (data?.current === name) {
        stopWaiting();
        reload();

        return;
      }

      // A server started again in the old environment after the restart failed: the one that would
      // have told this tab is gone.
      if (data?.failedSwitch?.name === name) {
        failureShown = name;
        showFailure(data.failedSwitch.error);

        return;
      }

      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        reset();
        deps.infoPopup({
          title: 'Environment switch',
          content: `The dev server did not come back in ${name} within ${POLL_TIMEOUT_MS / 1000} s: see its terminal.`,
          type: 'danger',
        });

        return;
      }

      pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };

    pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
  };

  // Asked again once the tab is back (its connection, or the tab itself): a tab whose connection was
  // down during a switch was never told, and would show the old environment, a Sync from it going to
  // the new one; one whose first ask failed (the server restarting) gets its list.
  const recheck = async () => {
    if (waiting !== undefined) {
      return;
    }

    const data = await ask();

    if (!data || waiting !== undefined) {
      return;
    }

    const serverEnv = data.current || DEFAULT_ENV_NAME;

    if (serverEnv !== current && reloadOnce(current, serverEnv)) {
      return;
    }

    current = serverEnv;
    build(data);
  };

  hot.on('vite:ws:disconnect', () => {
    disconnected = true;
  });
  hot.on('vite:ws:connect', () => {
    if (disconnected) {
      disconnected = false;
      void recheck();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void recheck();
    }
  });

  // Every tab: the restart begins.
  hot.on('env:switching', (payload: EnvSwitchPayload) => {
    failureShown = undefined;

    if ($select) {
      $select.value = payload.name;
      $select.disabled = true;
    }

    deps.infoPopup({
      title: 'Environment switch',
      content: `The dev server restarts in ${payload.name}; this tab reloads once it is up.`,
      type: 'info',
    });
    waitFor(payload.name);
  });

  // Refused, or the restart failed: the running server stays.
  hot.on('env:switch:failed', (payload: EnvSwitchFailedPayload) => {
    if (failureShown !== undefined && failureShown === payload.name) {
      failureShown = undefined;

      return;
    }

    showFailure(payload.error);
  });

  // The first answer: the list, in the environment the server says. Without one (the server
  // restarting), the handlers above ask again.
  const data = await ask();

  if (data) {
    const serverEnv = data.current || DEFAULT_ENV_NAME;

    if (serverEnv !== pageEnv && reloadOnce(pageEnv, serverEnv)) {
      return;
    }

    // Only once the two agree: a mark taken away while they don't let every other start reload.
    if (serverEnv === pageEnv) {
      try {
        window.sessionStorage.removeItem(MISMATCH_RELOAD_KEY);
      } catch {
        // Nothing kept.
      }
    }

    current = serverEnv;
    build(data);
  }
}
