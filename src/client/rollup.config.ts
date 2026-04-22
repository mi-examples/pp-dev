import { readFileSync, writeFileSync } from 'fs';
import { defineConfig } from 'rollup';
import typescript from '@rollup/plugin-typescript';
import scss from 'rollup-plugin-scss';
import url from '@rollup/plugin-url';
import { fileURLToPath } from 'url';
// import * as pkg from '../../package.json';
import * as path from 'path';
process.env.SASS_SILENCE_DEPRECATIONS = 'legacy-js-api';
import * as sass from 'sass';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const destinationPath = path.resolve(__dirname, '../..', 'dist/client');

/** Sass emits stdin-only names without sourcesContent; embed SCSS for published maps. */
function embedClientScssInCssSourcemap() {
  return {
    name: 'embed-client-scss-in-css-sourcemap',
    writeBundle() {
      const scssSourcePath = path.join(__dirname, 'assets/css/client.scss');
      const mapPath = path.join(destinationPath, 'client.css.map');
      const scss = readFileSync(scssSourcePath, 'utf-8');
      const map = JSON.parse(readFileSync(mapPath, 'utf-8'));

      map.sources = ['client.scss'];
      map.sourcesContent = [scss];
      writeFileSync(mapPath, JSON.stringify(map));
    },
  };
}

export default defineConfig({
  input: path.resolve(__dirname, 'index.ts'),
  plugins: [
    typescript({
      tsconfig: path.resolve(__dirname, './tsconfig.build.json'),
      sourceMap: true,
      declaration: false,
      compilerOptions: {
        removeComments: false,
        // Embed originals in .map so consumers (node_modules install) resolve without repo paths
        inlineSources: true,
      },
    }),
    scss({
      fileName: 'client.css',
      sourceMap: true,
      sass,
      silenceDeprecations: ['legacy-js-api'],
      outputStyle: 'compressed',
      // Better CSS optimization
      includePaths: ['node_modules'],
    }),
    embedClientScssInCssSourcemap(),
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
