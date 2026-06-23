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
  replaceDir(join(root, 'node_modules', 'ip-address'), join(npmRoot, 'node_modules', 'ip-address'));
  replaceDir(
    join(root, 'node_modules', 'picomatch'),
    join(npmRoot, 'node_modules', 'tinyglobby', 'node_modules', 'picomatch'),
  );
  // undici <=6.26.0 in npm's node-gyp: GHSA-p88m-4jfj-68fv, GHSA-vxpw-j846-p89q,
  // GHSA-35p6-xmwp-9g52, GHSA-g8m3-5g58-fq7m. node-gyp only uses fetch/Agent/
  // EnvHttpProxyAgent/RetryAgent — all present in undici v8.
  replaceDir(join(root, 'node_modules', 'undici'), join(npmRoot, 'node_modules', 'undici'));
}
