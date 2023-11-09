import { defineConfig } from 'rollup';
import typescript from '@rollup/plugin-typescript';
import dts from 'rollup-plugin-dts';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import pkg from './package.json' assert { type: 'json' };

const defaultConfig = defineConfig({
  input: {
    'index': 'src/index.ts',
    'plugin': 'src/plugin.ts',
    'cli': 'src/cli.ts',
    'helpers': 'src/helpers.ts',
  },
});

export default [
  defineConfig(
    Object.assign({}, defaultConfig, {
      plugins: [
        typescript({
          tsconfig: './tsconfig.esm.json',
        }),
      ],
      output: {
        dir: path.dirname((pkg.exports['.']).import),
        format: 'esm',
        assetFileNames: '[name][extname]',
        sourcemap: true,
        sourcemapPathTransform(relativeSourcePath: string) {
          return path.basename(relativeSourcePath);
        },
        sourcemapIgnoreList() {
          return true;
        },
      },
    }),
  ),
  defineConfig(
    Object.assign({}, defaultConfig, {
      plugins: [
        typescript({
          tsconfig: './tsconfig.cjs.json',
        }),
      ],
      output: {
        dir: path.dirname((pkg.exports['.']).require),
        format: 'cjs',
        assetFileNames: '[name][extname]',
        sourcemap: true,
        sourcemapPathTransform(relativeSourcePath: string) {
          return path.basename(relativeSourcePath);
        },
        sourcemapIgnoreList() {
          return true;
        },
      },
    }),
  ),
  defineConfig(
    Object.assign({}, defaultConfig, {
      output: {
        dir: path.dirname(pkg.types),
        format: 'esm',
        assetFileNames: '[name][extname]',
      },
      plugins: [
        dts({
          tsconfig: './tsconfig.types.json',
        }),
      ],
    }),
  ),
];
