/**
 * Switching the MI environment from the dev panel (PP-4840 phase 4): the dev server restarts in the
 * chosen one, as on a config change, until pp-dev stops.
 *
 * The panel's request reaches the dev server (ClientService); the restart is the command's to do:
 * `pp-dev` restarts its Vite server in the same process, `pp-dev next` asks its supervisor, which
 * starts a new server process. The command registers how; the dev server asks through here. On
 * `globalThis`, since the plugin can be loaded from another copy of this module (CJS and ESM).
 */
import { PP_DEV_ENV_SWITCH_FAILURE_VAR, PP_DEV_ENV_SWITCH_PENDING_VAR } from '../shared/mi-environments.js';

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

/**
 * Restarts the dev server in `name`. Resolves once a restart failed; on success this server goes.
 * Marked pending until then, for a server started while the switch waits (see
 * {@link getPendingEnvSwitch}).
 */
export async function requestEnvSwitch(name: string): Promise<EnvSwitchResult> {
  const handler = (globalThis as WithHandler)[HANDLER_KEY];

  if (!handler) {
    return { ok: false, error: 'This dev server cannot switch environments (started by another tool).' };
  }

  setPendingEnvSwitch(name);

  try {
    return await handler(name);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    setPendingEnvSwitch(undefined);
  }
}

/**
 * The environment a switch waits to go to, or goes to: one asked of this process, or (`pp-dev next`)
 * queued at the supervisor when it started this one. No sync and no other switch until it is over.
 */
export function getPendingEnvSwitch(env: Record<string, string | undefined> = process.env): string | undefined {
  return env[PP_DEV_ENV_SWITCH_PENDING_VAR] || undefined;
}

/** Marks a switch pending; `undefined` once it is over (done, failed or refused). */
export function setPendingEnvSwitch(
  name: string | undefined,
  env: Record<string, string | undefined> = process.env,
): void {
  if (name) {
    env[PP_DEV_ENV_SWITCH_PENDING_VAR] = name;
  } else {
    delete env[PP_DEV_ENV_SWITCH_PENDING_VAR];
  }
}

export interface EnvSwitchFailure {
  name: string;
  error: string;
}

/**
 * Records why a switch failed, for the tabs that wait for it (`GET /@api/environment`); `undefined`
 * clears it, as a switch starts. In the environment, so a server process started again after it gets
 * it (`pp-dev next`).
 */
export function setEnvSwitchFailure(
  failure: EnvSwitchFailure | undefined,
  env: Record<string, string | undefined> = process.env,
): void {
  if (failure) {
    env[PP_DEV_ENV_SWITCH_FAILURE_VAR] = JSON.stringify({ name: failure.name, error: failure.error });
  } else {
    delete env[PP_DEV_ENV_SWITCH_FAILURE_VAR];
  }
}

/** Why the last switch failed, if this server was started again after it. */
export function getEnvSwitchFailure(
  env: Record<string, string | undefined> = process.env,
): EnvSwitchFailure | undefined {
  const raw = env[PP_DEV_ENV_SWITCH_FAILURE_VAR];

  if (!raw) {
    return undefined;
  }

  try {
    const value = JSON.parse(raw) as Partial<EnvSwitchFailure>;

    return typeof value.name === 'string' && typeof value.error === 'string'
      ? { name: value.name, error: value.error }
      : undefined;
  } catch {
    return undefined;
  }
}
