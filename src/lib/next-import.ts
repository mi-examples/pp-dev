import { createRequire } from 'node:module';
import type next from 'next';
import type * as nextConstants from 'next/constants';

/**
 * Safe Next.js import utility
 * Handles peer dependency availability and provides helpful error messages
 */

export interface NextJSImports {
  next: typeof next;
  constants: typeof nextConstants;
}

/**
 * Safely imports Next.js modules
 * @throws {Error} When Next.js is not available as a peer dependency
 */
export async function safeNextImport(): Promise<NextJSImports> {
  try {
    const [next, constants] = await Promise.all([import('next'), import('next/constants.js')]);

    return {
      next: next.default,
      constants,
    };
  } catch (error) {
    throw new Error(
      `Next.js is required but not available. Please install Next.js as a dependency:\n` +
        `npm install next@^15\n` +
        `\nThis package requires Next.js >=15 <17 as a peer dependency.\n\n` +
        `Error: ${error}`,
    );
  }
}

/** Resolves modules from where pp-dev is installed, as `safeNextImport()`'s `import('next')` does. */
const requireFromPPDev = () => createRequire(import.meta.url);

/**
 * Checks if Next.js is available without importing it: resolving its entry is enough, and loading
 * Next.js itself takes seconds.
 */
export async function isNextAvailable(): Promise<boolean> {
  try {
    requireFromPPDev().resolve('next');

    return true;
  } catch {
    return false;
  }
}

/**
 * Gets Next.js version if available
 */
export async function getNextVersion(): Promise<string | null> {
  try {
    // A JSON module can't be imported without `with { type: 'json' }` (ERR_IMPORT_ATTRIBUTE_MISSING,
    // so this always returned null); `require` reads it in both builds.
    const nextPkg = requireFromPPDev()('next/package.json') as { version?: unknown };

    return typeof nextPkg.version === 'string' ? nextPkg.version : null;
  } catch {
    return null;
  }
}
