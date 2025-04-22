import { defineConfig, RollupOptions } from 'rollup';
import typescript from '@rollup/plugin-typescript';
import dts from 'rollup-plugin-dts';
import terser from '@rollup/plugin-terser';
import * as path from 'path';
import * as fs from 'fs';

// Read package.json safely
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));

const defaultConfig: RollupOptions = {
  input: {
    index: 'src/index.ts',
    plugin: 'src/plugin.ts',
    cli: 'src/cli.ts',
    helpers: 'src/helpers.ts',
  },
  treeshake: true,
  logLevel: 'debug',
  onwarn(warning, warn) {
    if (warning.code === 'CIRCULAR_DEPENDENCY') {
      return;
    }
    warn(warning);
  },
};

const configs: RollupOptions[] = [
  // ESM Build
  defineConfig({
    ...defaultConfig,
    plugins: [
      typescript({
        tsconfig: './tsconfig.esm.json',
        declaration: false,
        sourceMap: true,
      }),
      terser({
        format: {
          comments: false,
        },
      }),
    ],
    output: {
      dir: path.dirname(pkg.exports['.'].import),
      format: 'esm',
      assetFileNames: '[name][extname]',
      sourcemap: true,
    },
    external: [...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies)],
  }),

  // CJS Build
  defineConfig({
    ...defaultConfig,
    plugins: [
      typescript({
        tsconfig: './tsconfig.cjs.json',
        declaration: false,
        sourceMap: true,
      }),
      terser({
        format: {
          comments: false,
        },
      }),
    ],
    output: {
      dir: path.dirname(pkg.exports['.'].require),
      format: 'cjs',
      assetFileNames: '[name][extname]',
      sourcemap: true,
    },
    external: [...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies)],
  }),

  // Type Definitions
  defineConfig({
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
    external: [...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies)],
  }),
];

export default configs;
