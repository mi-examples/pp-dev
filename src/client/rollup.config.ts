import { defineConfig } from 'rollup';
import typescript from '@rollup/plugin-typescript';
import scss from 'rollup-plugin-scss';
import url from '@rollup/plugin-url';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import { fileURLToPath } from 'url';
// import * as pkg from '../../package.json';
import * as path from 'path';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const destinationPath = path.resolve(__dirname, '../..', 'dist/client');

export default defineConfig({
  input: path.resolve(__dirname, 'index.ts'),
  plugins: [
    nodeResolve(),
    typescript({
      tsconfig: path.resolve(__dirname, './tsconfig.json'),
    }),
    scss(),
    url({
      fileName: '[name][extname]',
      include: ['**/*.svg', '**/*.png', '**/*.jp(e)?g', '**/*.gif', '**/*.webp', '**/*.html'],
      limit: 0,
    }),
  ],
  output: {
    file: path.resolve(destinationPath, 'client.js'),
    assetFileNames: '[name][extname]',
    sourcemap: true,
    sourcemapPathTransform(relativeSourcePath) {
      return path.basename(relativeSourcePath);
    },
    sourcemapIgnoreList() {
      return true;
    },
  },
  // build: {
  //   outDir: '../../dist/client',
  //   emptyOutDir: true,
  //   sourcemap: true,
  //   manifest: false,
  //   // lib: {
  //   //   name: 'client',
  //   //   entry: './index.ts',
  //   //   fileName: 'client',
  //   // },
  // },
});
