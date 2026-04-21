/**
 * The `npm` package vendors dependencies (bundleDependencies). npm overrides do not
 * replace those copies, so `npm audit` still flags known-fixed versions that exist
 * hoisted at the project root. Sync patched trees into npm's bundle after install.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const npmRoot = join(root, 'node_modules', 'npm');

function replaceDir(src, dest) {
  if (!existsSync(src) || !existsSync(dirname(dest))) {
    return;
  }
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
}

if (existsSync(npmRoot)) {
  replaceDir(join(root, 'node_modules', 'brace-expansion'), join(npmRoot, 'node_modules', 'brace-expansion'));
  replaceDir(
    join(root, 'node_modules', 'picomatch'),
    join(npmRoot, 'node_modules', 'tinyglobby', 'node_modules', 'picomatch'),
  );
}
