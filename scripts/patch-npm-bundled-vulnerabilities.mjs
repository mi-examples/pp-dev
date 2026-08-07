/**
 * The `npm` package vendors dependencies (bundleDependencies). npm overrides do not
 * replace those copies, so `npm audit` still flags known-fixed versions that exist
 * hoisted at the project root. Sync patched trees into npm's bundle after install.
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const npmRoot = join(root, 'node_modules', 'npm');
const lockfilePath = join(root, 'package-lock.json');

// Required packages fail the postinstall loudly when they can't be patched — a silent
// no-op here would let `npm install` succeed while the vendored vulnerable copy inside
// npm's bundle stays in place, and that regression wouldn't surface until a later
// `npm run audit:all`. `picomatch` is optional: it only exists nested under npm's bundled
// `tinyglobby`, a layout detail that can legitimately disappear across npm version bumps.
function replaceDir(src, dest, { optional = false } = {}) {
  const missing = !existsSync(src) ? src : !existsSync(dirname(dest)) ? dirname(dest) : null;

  if (missing) {
    if (optional) {
      return null;
    }

    throw new Error(`Cannot patch bundled dependency: expected "${missing}" to exist (source "${src}", destination "${dest}")`);
  }

  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });

  return dest;
}

const patchedDirs = [];

if (existsSync(npmRoot)) {
  patchedDirs.push(replaceDir(join(root, 'node_modules', 'brace-expansion'), join(npmRoot, 'node_modules', 'brace-expansion')));
  patchedDirs.push(replaceDir(join(root, 'node_modules', 'ip-address'), join(npmRoot, 'node_modules', 'ip-address')));
  patchedDirs.push(replaceDir(join(root, 'node_modules', 'tar'), join(npmRoot, 'node_modules', 'tar')));
  patchedDirs.push(replaceDir(join(root, 'node_modules', 'undici'), join(npmRoot, 'node_modules', 'undici')));
  patchedDirs.push(
    replaceDir(join(root, 'node_modules', 'picomatch'), join(npmRoot, 'node_modules', 'tinyglobby', 'node_modules', 'picomatch'), {
      optional: true,
    }),
  );
}

// `npm audit`/`npm ls` read package-lock.json's recorded "version" fields, not the files on
// disk — without this, the directory copies above are invisible to that tooling and the
// advisories keep reappearing even though the vulnerable code has already been replaced.
if (existsSync(lockfilePath)) {
  const original = readFileSync(lockfilePath, 'utf-8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lockfile = JSON.parse(original);
  let changed = false;

  for (const dest of patchedDirs) {
    if (!dest) {
      continue;
    }

    const key = relative(root, dest).split('\\').join('/');
    const pkgJsonPath = join(dest, 'package.json');

    if (!existsSync(pkgJsonPath) || !lockfile.packages?.[key]) {
      continue;
    }

    const realVersion = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')).version;

    if (lockfile.packages[key].version !== realVersion) {
      lockfile.packages[key].version = realVersion;
      changed = true;
    }
  }

  if (changed) {
    const serialized = (JSON.stringify(lockfile, null, 2) + '\n').split('\n').join(eol);

    writeFileSync(lockfilePath, serialized);
  }
}
