import path from 'path';
import fs from 'fs';

/**
 * Marks each build format for Node: `dist/esm/*.js` is ESM and `dist/cjs/*.js` is CommonJS, in a
 * package whose own `type` is one of the two. A `package.json` with the matching `type` in each
 * folder is all that takes; the full package.json copied here before (bin, exports, dependencies)
 * and the README/CHANGELOG copies only made the tarball bigger.
 */
const distPath = path.resolve(fs.realpathSync(process.cwd()), 'dist');

for (const [folder, type] of [
  ['esm', 'module'],
  ['cjs', 'commonjs'],
]) {
  const dir = path.resolve(distPath, folder);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.resolve(dir, 'package.json'), `${JSON.stringify({ type }, null, 2)}\n`);
}

console.log('✅ Post-build processing completed successfully');
console.log(`📦 ESM build: ${path.resolve(distPath, 'esm')}`);
console.log(`📦 CJS build: ${path.resolve(distPath, 'cjs')}`);
console.log(`📦 Types: ${path.resolve(distPath, 'types')}`);
console.log(`📦 Client: ${path.resolve(distPath, 'client')}`);
