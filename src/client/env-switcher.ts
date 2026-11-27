/**
 * The dev panel's MI environment switcher (PP-4840 phase 4): with more than one environment in the
 * config, the environment's name becomes a list. A choice restarts the dev server in it, until pp-dev
 * stops; every tab of the server is told, and reloads once the server works with the chosen one.
 */
import type { ViteHotContext } from 'vite/types/hot.js';
import type { InfoPopupOptions } from './popup.js';
import type { ConfirmModalOptions } from './sync-button.js';
import type { EnvSwitchFailedPayload, EnvSwitchPayload, EnvironmentResponse } from '../shared/ws-messages.js';

export const ENVIRONMENT_API = '/@api/environment';

/** How often a tab asks whether the restarted server is up, and for how long. */
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 120_000;

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
  hot: Pick<ViteHotContext, 'on' | 'send'>,
  $section: HTMLElement,
  deps: EnvSwitcherDeps,
): Promise<void> {
  const reload = deps.reload ?? (() => window.location.reload());
  const get = deps.fetch ?? ((input, init) => window.fetch(input, init));

  let data: EnvironmentResponse;

  try {
    const response = await get(ENVIRONMENT_API, { cache: 'no-store' });

    if (!response.ok) {
      return;
    }

    data = (await response.json()) as EnvironmentResponse;
  } catch {
    // A dev server older than the panel: the name stays as the markup shows it.
    return;
  }

  // One environment, or a server that can't restart in another (plain `vite` with the plugin).
  if (!Array.isArray(data.environments) || data.environments.length < 2 || data.canSwitch === false) {
    return;
  }

  const $value = $section.querySelector<HTMLElement>('.pp-dev-info__env');
  const $select = document.createElement('select');

  $select.className = 'pp-dev-info__env-select';
  $select.title = 'MI environment: a choice restarts the dev server in it';
  $select.setAttribute('aria-label', 'MI environment');

  for (const choice of data.environments) {
    const $option = document.createElement('option');

    $option.value = choice.name;
    $option.textContent = describeChoice(choice);
    $option.disabled = !choice.hasUrl;
    $option.selected = choice.name === data.current;
    $select.append($option);
  }

  $value?.replaceWith($select);
  $section.classList.remove('pp-dev-info__env-section--none');

  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const stopPolling = () => {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  };

  const reset = () => {
    stopPolling();
    $select.value = data.current;
    $select.disabled = false;
  };

  // A tab whose connection was down during a switch was never told: it would show the old
  // environment, and a Sync from it would go to the new one. Asked again once it is back (the
  // connection, or the tab itself), it reloads when the server works with another one now.
  let disconnected = false;

  const recheck = async () => {
    if (pollTimer !== undefined) {
      return;
    }

    try {
      const response = await get(ENVIRONMENT_API, { cache: 'no-store' });

      if (response.ok && ((await response.json()) as EnvironmentResponse).current !== data.current) {
        reload();
      }
    } catch {
      // Not back yet: the next reconnect asks again.
    }
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

  /** Reloads once the dev server answers with `name`: the restarted one. */
  const waitFor = (name: string) => {
    const startedAt = Date.now();

    stopPolling();

    const poll = async () => {
      try {
        const response = await get(ENVIRONMENT_API, { cache: 'no-store' });

        if (response.ok && ((await response.json()) as EnvironmentResponse).current === name) {
          stopPolling();
          reload();

          return;
        }
      } catch {
        // The server is restarting.
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

  $select.addEventListener('change', async () => {
    const name = $select.value;

    if (name === data.current) {
      return;
    }

    const confirmed = await deps.confirmModal({
      title: 'Switch MI environment',
      content: `Restart the dev server in ${name}? Every tab of it reloads; the choice lasts until pp-dev stops.`,
      confirmText: `Switch to ${name}`,
      cancelText: 'Cancel',
    });

    if (!confirmed) {
      $select.value = data.current;

      return;
    }

    $select.disabled = true;
    hot.send('env:switch', { name } satisfies EnvSwitchPayload);
  });

  // Every tab: the restart begins.
  hot.on('env:switching', (payload: EnvSwitchPayload) => {
    $select.value = payload.name;
    $select.disabled = true;
    deps.infoPopup({
      title: 'Environment switch',
      content: `The dev server restarts in ${payload.name}; this tab reloads once it is up.`,
      type: 'info',
    });
    waitFor(payload.name);
  });

  // Refused, or the restart failed: the running server stays.
  hot.on('env:switch:failed', (payload: EnvSwitchFailedPayload) => {
    reset();
    deps.infoPopup({
      title: 'Environment switch failed',
      content: `The dev server stays in ${data.current}: ${payload.error}`,
      type: 'danger',
    });
  });
}
