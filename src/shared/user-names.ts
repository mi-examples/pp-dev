/**
 * The rules for a saved user's name, which is also its host (`<name>.localhost`), for both sides:
 * the server checks them (`src/lib/user-registry.ts`) and the dev panel's Users popover
 * (`src/client/users-panel.ts`) checks them as you type. No Node or DOM imports: the panel bundle
 * includes it.
 */

/** Longest user name; well under the 63 characters a DNS label allows. */
export const MAX_USER_NAME_LENGTH = 32;

/**
 * A DNS label: lowercase latin letters, digits and `-`, starting with a letter and not ending with
 * `-`. Also used as an input's `pattern`, which browsers compile with the `v` flag: there an
 * unescaped `-` in a class is a syntax error, and the whole pattern was silently ignored.
 */
export const USER_NAME_PATTERN = String.raw`[a-z](?:[a-z0-9\-]*[a-z0-9])?`;

const USER_NAME_REGEXP = new RegExp(`^(?:${USER_NAME_PATTERN})$`);

/** The suffix of a user's host: `viewer` works on `viewer.localhost`. */
export const USER_HOST_SUFFIX = '.localhost';

/** Why `name` can't be a user name, or `undefined` if it can. */
export function getUserNameError(name: string): string | undefined {
  if (!name) {
    return 'The name is required';
  }

  if (name.length > MAX_USER_NAME_LENGTH) {
    return `The name must be at most ${MAX_USER_NAME_LENGTH} characters long`;
  }

  if (!USER_NAME_REGEXP.test(name)) {
    return 'The name may contain only lowercase latin letters, digits and "-", must start with a letter and must not end with "-"';
  }

  return undefined;
}
