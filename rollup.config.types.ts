// @ts-nocheck
import { defineConfig } from 'rollup';
import dts from 'rollup-plugin-dts';
import * as path from 'path';
import * as fs from 'fs';
import { builtinModules } from 'module';

const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));

const externalDeps = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.peerDependencies || {})];

const nodeBuiltins = new Set(builtinModules.flatMap((mod) => [mod, `node:${mod}`]));
const additionalExternal = new Set(['postcss', 'rollup', 'vite', 'estree']);

const isExternal = (id) => {
  if (nodeBuiltins.has(id)) return true;
  if (externalDeps.includes(id)) return true;
  if (additionalExternal.has(id)) return true;
  return externalDeps.some((dep) => id.startsWith(`${dep}/`));
};

// One entry per subpath in package.json `exports` with a `types` target: with `index` alone, the
// published `dist/types/` held one file, and `@metricinsights/pp-dev/plugin` and `/helpers` had no
// types for their users (TS7016).
export default defineConfig({
  input: {
    index: 'src/index.ts',
    plugin: 'src/plugin.ts',
    helpers: 'src/helpers.ts',
  },
  plugins: [
    dts({
      tsconfig: './tsconfig.types.json',
      compilerOptions: {
        declaration: true,
        declarationMap: false,
        sourceMap: false,
      },
      respectExternal: true,
    }),
  ],
  output: {
    dir: path.dirname(pkg.types),
    format: 'esm',
    assetFileNames: '[name][extname]',
  },
  external: isExternal,
});
