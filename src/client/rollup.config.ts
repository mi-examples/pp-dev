import { defineConfig } from 'rollup';
import typescript from '@rollup/plugin-typescript';
import scss from 'rollup-plugin-scss';
import url from '@rollup/plugin-url';
import { fileURLToPath } from 'url';
// import * as pkg from '../../package.json';
import * as path from 'path';
import * as sass from 'sass';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const destinationPath = path.resolve(__dirname, '../..', 'dist/client');

export default defineConfig({
  input: path.resolve(__dirname, 'index.ts'),
  plugins: [
    typescript({
      tsconfig: path.resolve(__dirname, './tsconfig.build.json'),
      sourceMap: true,
      declaration: false,
      compilerOptions: {
        removeComments: false,
      },
    }),
    scss({
      fileName: 'client.css',
      sourceMap: true,
      sass,
      outputStyle: 'compressed',
      // Better CSS optimization
      includePaths: ['node_modules'],
    }),
    url({
      fileName: '[name][extname]',
      include: ['**/*.svg', '**/*.png', '**/*.jp(e)?g', '**/*.gif', '**/*.webp', '**/*.html', '**/*.css'],
      limit: 0,
      // Better asset handling
      publicPath: '/assets/',
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
    // Better code generation
    generatedCode: {
      constBindings: true,
      objectShorthand: true,
      arrowFunctions: true,
    },
  },
  // Better tree-shaking
  treeshake: {
    moduleSideEffects: false,
    propertyReadSideEffects: false,
    unknownGlobalSideEffects: false,
  },
});
