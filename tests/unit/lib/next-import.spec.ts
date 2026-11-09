import { describe, it, expect } from 'vitest';
import { getNextVersion, isNextAvailable } from '../../../src/lib/next-import.js';

/**
 * `getNextVersion()` imported `next/package.json` without `with { type: 'json' }`, which Node
 * refuses for an ES module (ERR_IMPORT_ATTRIBUTE_MISSING), so it always returned null.
 */
describe('next-import', () => {
  it('reads the installed Next.js version', async () => {
    expect(await getNextVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('finds Next.js', async () => {
    expect(await isNextAvailable()).toBe(true);
  });
});
