import type next from "next";
import type * as nextConstants from "next/constants";

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
    const [next, constants] = await Promise.all([
      import("next"),
      import("next/constants.js"),
    ]);

    return {
      next: next.default,
      constants,
    };
  } catch (error) {
    throw new Error(
      `Next.js is required but not available. Please install Next.js as a dependency:\n` +
        `npm install next@^15\n` +
        `\nThis package requires Next.js >=15 <17 as a peer dependency.\n\n` +
        `Error: ${error}`
    );
  }
}

/**
 * Checks if Next.js is available without importing it
 */
export async function isNextAvailable(): Promise<boolean> {
  try {
    await import("next");
    
    return true;
  } catch (error) {
    console.log(error);
    return false;
  }
}

/**
 * Gets Next.js version if available
 */
export async function getNextVersion(): Promise<string | null> {
  try {
    const nextPkg = await import("next/package.json");

    return nextPkg.version;
  } catch {
    return null;
  }
}
