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
 * Where the API token of an environment is set, for messages: `mi.token or MI_ACCESS_TOKEN` for the
 * top-level settings, the environment's own for a named one (it never falls back to those).
 */
export function describeTokenSettings(envName?: string): string {
  return envName
    ? `envs.${envName}.token or MI_ACCESS_TOKEN_${envVariableSuffix(envName)}`
    : 'mi.token or MI_ACCESS_TOKEN';
}
