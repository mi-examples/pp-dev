import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearConfigCache, findConfig, getConfig } from '../../../src/config.js';

/**
 * Whether a project has a standalone pp-dev config at all: `getConfig()` answers `{}` both for a
 * project without one and for an empty one, and a check that validated that answer refused every
 * config change of a project whose pp-dev config lives in `next.config` (`withPPDev()`).
 */
describe('findConfig', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-find-config-'));
    clearConfigCache();
  });

  afterEach(() => {
    clearConfigCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds a pp-dev.config file', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"file-app"}');
    fs.writeFileSync(path.join(root, 'pp-dev.config.mjs'), "export default { app: { id: 3, type: 'template' } };\n");

    await expect(findConfig(root)).resolves.toEqual({ config: { app: { id: 3, type: 'template' } }, found: true });
  });

  it("finds package.json's pp-dev", async () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"pkg-app","pp-dev":{"app":{"id":4,"type":"page"}}}');

    await expect(findConfig(root)).resolves.toEqual({ config: { app: { id: 4, type: 'page' } }, found: true });
  });

  // A file that exports nothing (null, a half-written save) or a package key of the wrong kind
  // counted as no config at all: the supervisor's check let the change through, stopped the
  // working server, and the new one refused the empty config.
  it('finds a config file whatever it exports', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"null-app"}');
    fs.writeFileSync(path.join(root, 'pp-dev.config.mjs'), 'export default null;\n');

    await expect(findConfig(root)).resolves.toEqual({ config: {}, found: true });
  });

  it("finds package.json's pp-dev whatever it holds", async () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"pkg-app","pp-dev":"oops"}');

    await expect(findConfig(root)).resolves.toEqual({ config: {}, found: true });
  });

  it('finds none in a project whose config lives in next.config', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"next-app"}');
    fs.writeFileSync(path.join(root, 'next.config.mjs'), 'export default {};\n');

    await expect(findConfig(root)).resolves.toEqual({ config: {}, found: false });
    await expect(getConfig(root)).resolves.toEqual({});
  });
});
