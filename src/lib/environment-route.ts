/**
 * `GET /@api/environment` (PP-4840 phase 4): the MI environment the dev server works with and the
 * ones the dev panel offers. The panel asks it when it opens, not from the page's markup, and again
 * while a switch restarts the server, to reload once the new one answers with the chosen name.
 */
import type { Application } from 'express';
import type { EnvironmentChoice } from './pp-dev-config.js';
import type { EnvironmentResponse } from '../shared/ws-messages.js';
import { canSwitchEnvironments, getEnvSwitchFailure } from './env-switch.js';

export const ENVIRONMENT_API_PATH = '/@api/environment';

interface EnvironmentRouteDeps {
  current: string;
  environments: EnvironmentChoice[];
}

/** One route per app; a server restarted on the same app gets the new answer. */
const routeStates = new WeakMap<Application, { deps: EnvironmentRouteDeps }>();

export function registerEnvironmentRoute(app: Application, deps: EnvironmentRouteDeps): void {
  const existing = routeStates.get(app);

  if (existing) {
    existing.deps = deps;

    return;
  }

  const state = { deps };

  routeStates.set(app, state);

  app.get(ENVIRONMENT_API_PATH, (_req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.json({
      current: state.deps.current,
      environments: state.deps.environments,
      canSwitch: canSwitchEnvironments(),
      failedSwitch: getEnvSwitchFailure(),
    } satisfies EnvironmentResponse);
  });
}
