import { defineConfig, RollupOptions } from 'rollup';
import typescript from '@rollup/plugin-typescript';
import dts from 'rollup-plugin-dts';
import terser from '@rollup/plugin-terser';
import * as path from 'path';
import * as fs from 'fs';

// Read package.json safely
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));

// Common external dependencies
const externalDeps = [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
  // Exclude dev dependencies from external as they shouldn't be bundled
];

const defaultConfig: RollupOptions = {
  input: {
    index: 'src/index.ts',
    plugin: 'src/plugin.ts',
    cli: 'src/cli.ts',
    helpers: 'src/helpers.ts',
  },
  treeshake: {
    moduleSideEffects: false,
    propertyReadSideEffects: false,
    unknownGlobalSideEffects: false,
  },
  logLevel: 'info', // Reduced from debug for cleaner output
  onwarn(warning, warn) {
    if (warning.code === 'CIRCULAR_DEPENDENCY') {
      return;
    }
    if (warning.code === 'UNUSED_EXTERNAL_IMPORT') {
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
        compilerOptions: {
          removeComments: false,
        },
      }),
      terser({
        format: {
          comments: false,
        },
        compress: {
          drop_console: false, // Keep console logs for debugging
          drop_debugger: true,
          pure_funcs: ['console.log'], // Remove console.log in production
        },
        mangle: {
          properties: false, // Don't mangle property names
        },
      }),
    ],
    output: {
      dir: path.dirname(pkg.exports['.'].import),
      format: 'esm',
      assetFileNames: '[name][extname]',
      sourcemap: true,
      exports: 'named',
              generatedCode: {
          constBindings: true,
          objectShorthand: true,
          arrowFunctions: true,
        },
      // Better chunking for code splitting
      chunkFileNames: '[name]-[hash].js',
      entryFileNames: '[name].js',
    },
    external: externalDeps,
    // Better tree-shaking
    preserveEntrySignatures: 'strict',
  }),

  // CJS Build
  defineConfig({
    ...defaultConfig,
    plugins: [
      typescript({
        tsconfig: './tsconfig.cjs.json',
        declaration: false,
        sourceMap: true,
        compilerOptions: {
          removeComments: false,
        },
      }),
      terser({
        format: {
          comments: false,
        },
        compress: {
          drop_console: false,
          drop_debugger: true,
          pure_funcs: ['console.log'],
        },
        mangle: {
          properties: false,
        },
      }),
    ],
    output: {
      dir: path.dirname(pkg.exports['.'].require),
      format: 'cjs',
      assetFileNames: '[name][extname]',
      sourcemap: true,
      exports: 'named',
              generatedCode: {
          constBindings: true,
          objectShorthand: true,
          arrowFunctions: true,
        },
      chunkFileNames: '[name]-[hash].js',
      entryFileNames: '[name].js',
    },
    external: externalDeps,
    preserveEntrySignatures: 'strict',
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
    external: [
      ...externalDeps,
      // Add problematic dependencies to external
      'postcss',
      'rollup',
      'vite',
      'estree',
    ],
  }),
];

export default configs;
