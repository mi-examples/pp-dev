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

/**
 * Sass emits stdin-only names without sourcesContent; embed SCSS for published maps.
 * (Typed by default values: rollup reads this file as JavaScript, tsc checks it as TypeScript.)
 */
function embedScssInCssSourcemap(scssPath = '', cssFileName = '') {
  return {
    name: 'embed-client-scss-in-css-sourcemap',
    writeBundle() {
      const scssSourcePath = path.join(__dirname, scssPath);
      const mapPath = path.join(destinationPath, `${cssFileName}.map`);
      const scss = readFileSync(scssSourcePath, 'utf-8');
      const map = JSON.parse(readFileSync(mapPath, 'utf-8'));

      map.sources = [path.basename(scssPath)];
      map.sourcesContent = [scss];
      writeFileSync(mapPath, JSON.stringify(map));
    },
  };
}

/**
 * One page's bundle in dist/client: `<name>.js`, `<name>.css` (from the SCSS the entry imports)
 * and the HTML it imports, each with a source map.
 */
function clientBundle(entry = '', name = '', scssPath = '') {
  return defineConfig({
    input: path.resolve(__dirname, entry),
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
        fileName: `${name}.css`,
        sourceMap: true,
        sass,
        // Passed on to sass as is; the plugin's options type doesn't list sass's own options.
        ...{ silenceDeprecations: ['legacy-js-api'] },
        outputStyle: 'compressed',
        // Better CSS optimization
        includePaths: ['node_modules'],
      }),
      embedScssInCssSourcemap(scssPath, `${name}.css`),
      url({
        fileName: '[name][extname]',
        include: ['**/*.svg', '**/*.png', '**/*.jp(e)?g', '**/*.gif', '**/*.webp', '**/*.html', '**/*.css'],
        limit: 0,
        // Better asset handling
        publicPath: '/assets/',
      }),
    ],
    output: {
      file: path.resolve(destinationPath, `${name}.js`),
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
}

export default [
  // The dev panel injected into the page.
  clientBundle('index.ts', 'client', 'assets/css/client.scss'),
  // The Request Inspector page, /@pp-dev/inspector.
  clientBundle('request-inspector/main.ts', 'request-inspector', 'request-inspector/request-inspector.scss'),
];
