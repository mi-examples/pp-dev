/**
 * What a dev server restart in the same process (`pp-dev`) changes in this process as it sets up,
 * before it can still fail: the users and the login on the main host (dropped for another MI
 * instance), and the environment the proxy cache is of. A restart that fails while the running
 * server stays puts them back, so that server keeps its own (PP-4840).
 */
import { saveUsersState, restoreUsersState } from './user-store.js';
import { getMiEnvironment, restoreMiEnvironment } from './proxy-cache.middleware.js';

/** Takes the state as it is; the function returned puts it back. */
export function saveDevServerState(): () => void {
  const users = saveUsersState();
  const environment = getMiEnvironment();

  return () => {
    restoreMiEnvironment(environment);
    restoreUsersState(users);
  };
}
