/**
 * `protected` MI environments (PP-4840, phase 2): a sync and a Variables Editor save, the two writes
 * to MI a developer starts, ask for a confirmation that names the environment the dev server works
 * with now, not the one a tab was opened with (`mi.protected`, `envs.<name>.protected`).
 */
import { DEFAULT_ENV_NAME } from './pp-dev-config.js';

/** The protected environment the dev server works with. */
export interface ProtectedEnvironment {
  /** The named environment; `undefined` for the top-level settings (`default`). */
  name?: string;
  url: string;
  appId?: number;
}

const trimUrl = (url: string) => url.replace(/\/+$/, '');

/** `staging (https://mi.example.com, app 42)`: the name alone doesn't say which MI it is. */
export function describeEnvironment(environment: ProtectedEnvironment): string {
  const where = [trimUrl(environment.url), environment.appId !== undefined ? `app ${environment.appId}` : '']
    .filter(Boolean)
    .join(', ');

  return `${environment.name ?? DEFAULT_ENV_NAME} (${where})`;
}

/**
 * What a confirmation is given for: the environment with its MI and page. A save confirmed for one
 * is asked again after a restart into another one, even of the same name.
 */
export function getEnvironmentConfirmation(environment: ProtectedEnvironment): string {
  return [environment.name ?? DEFAULT_ENV_NAME, trimUrl(environment.url), environment.appId ?? ''].join(' ');
}
