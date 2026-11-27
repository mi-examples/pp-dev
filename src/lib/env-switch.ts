/**
 * Switching the MI environment from the dev panel (PP-4840 phase 4): the dev server restarts in the
 * chosen one, as on a config change, until pp-dev stops.
 *
 * The panel's request reaches the dev server (ClientService); the restart is the command's to do:
 * `pp-dev` restarts its Vite server in the same process, `pp-dev next` asks its supervisor, which
 * starts a new server process. The command registers how; the dev server asks through here. On
 * `globalThis`, since the plugin can be loaded from another copy of this module (CJS and ESM).
 */

export type EnvSwitchResult = { ok: true } | { ok: false; error: string };

export type EnvSwitchHandler = (name: string) => Promise<EnvSwitchResult>;

const HANDLER_KEY = Symbol.for('pp-dev.envSwitchHandler');

type WithHandler = typeof globalThis & { [HANDLER_KEY]?: EnvSwitchHandler };

/** The command's way to restart in another environment; `undefined` takes it back. */
export function setEnvSwitchHandler(handler: EnvSwitchHandler | undefined): void {
  (globalThis as WithHandler)[HANDLER_KEY] = handler;
}

/** Whether the command can restart in another environment: not under plain `vite` with the plugin. */
export function canSwitchEnvironments(): boolean {
  return typeof (globalThis as WithHandler)[HANDLER_KEY] === 'function';
}

/** Restarts the dev server in `name`. Resolves once a restart failed; on success this server goes. */
export async function requestEnvSwitch(name: string): Promise<EnvSwitchResult> {
  const handler = (globalThis as WithHandler)[HANDLER_KEY];

  if (!handler) {
    return { ok: false, error: 'This dev server cannot switch environments (started by another tool).' };
  }

  try {
    return await handler(name);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
