/**
 * Named MI environments (PP-4840), the parts the dev server and the dev panel both use. No Node or
 * DOM APIs here: the panel bundle imports this file too.
 */

/** The suffix of an environment's variables: `staging-eu` → `STAGING_EU` (`MI_ACCESS_TOKEN_STAGING_EU`). */
export function envVariableSuffix(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * The code of the 409 a save of Variables Editor values gets in a `protected` environment until it is
 * confirmed: the body has the question (`error`), and the `confirmation` to send back with the save.
 */
export const PROTECTED_ENVIRONMENT_CODE = 'PROTECTED_ENVIRONMENT';

/**
 * The code of the 409 a save of Variables Editor values gets when they were loaded in another MI
 * environment than the one the dev server works with now (a switch from the dev panel, PP-4840).
 */
export const ENVIRONMENT_CHANGED_CODE = 'ENVIRONMENT_CHANGED';

/**
 * The MI environment chosen in the dev panel (PP-4840 phase 4), for as long as pp-dev runs. It wins
 * over `--env`, `MI_ENV` and `defaultEnv`: `MI_ENV` would not do, since a reload of the `.env` files
 * drops a value read from them and `pp-dev next` starts its server process with the original
 * `--env`. An environment variable, so the Next.js server process and the build a sync runs get it.
 * pp-dev's own: not to be set by hand.
 */
export const PP_DEV_SWITCHED_ENV_VAR = 'PP_DEV_SWITCHED_ENV';

/**
 * Why the last switch from the dev panel failed, `{"name","error"}` as JSON, when the server running
 * now was started again in the environment it had: the one that told the tabs is gone with the failed
 * restart (`pp-dev next` starts a new server process, `pp-dev` a new Vite server), so the tabs waiting
 * for the switch learn it from `GET /@api/environment`. Cleared when a switch starts. pp-dev's own.
 */
export const PP_DEV_ENV_SWITCH_FAILURE_VAR = 'PP_DEV_ENV_SWITCH_FAILURE';

/** The name the top-level `mi` and `app` settings go by in `--env`, `MI_ENV` and `defaultEnv`. */
export const DEFAULT_ENV_NAME = 'default';

/**
 * Where the API token of an environment is set, for messages: `mi.token or MI_ACCESS_TOKEN` for the
 * top-level settings, the environment's own for a named one (it never falls back to those).
 */
export function describeTokenSettings(envName?: string): string {
  return envName
    ? `envs.${envName}.token or MI_ACCESS_TOKEN_${envVariableSuffix(envName)}`
    : 'mi.token or MI_ACCESS_TOKEN';
}
