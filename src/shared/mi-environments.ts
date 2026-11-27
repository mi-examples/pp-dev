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
 * Where the API token of an environment is set, for messages: `mi.token or MI_ACCESS_TOKEN` for the
 * top-level settings, the environment's own for a named one (it never falls back to those).
 */
export function describeTokenSettings(envName?: string): string {
  return envName
    ? `envs.${envName}.token or MI_ACCESS_TOKEN_${envVariableSuffix(envName)}`
    : 'mi.token or MI_ACCESS_TOKEN';
}
