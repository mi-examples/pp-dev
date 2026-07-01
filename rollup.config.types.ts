// @ts-nocheck
import { defineConfig } from 'rollup';
import dts from 'rollup-plugin-dts';
import * as path from 'path';
import * as fs from 'fs';
import { builtinModules } from 'module';

const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));

const externalDeps = [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
];

const nodeBuiltins = new Set(builtinModules.flatMap((mod) => [mod, `node:${mod}`]));
const additionalExternal = new Set(['postcss', 'rollup', 'vite', 'estree']);

const isExternal = (id) => {
  if (nodeBuiltins.has(id)) return true;
  if (externalDeps.includes(id)) return true;
  if (additionalExternal.has(id)) return true;
  return externalDeps.some((dep) => id.startsWith(`${dep}/`));
};

export default defineConfig({
  input: 'src/index.ts',
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
