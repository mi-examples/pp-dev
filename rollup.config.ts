import { defineConfig, Plugin, RollupOptions } from 'rollup';
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
  // Preserve Node.js globals
  context: 'globalThis',
};

function typeDefsTracePlugin(): Plugin {
  let transformCount = 0;
  const startedAt = Date.now();
  const logTrace = (message: string) => {
    const elapsedMs = Date.now() - startedAt;
    console.info(`[rollup:dts:trace] +${elapsedMs}ms ${message}`);
  };

  return {
    name: 'type-defs-trace',
    buildStart() {
      logTrace('buildStart');
    },
    resolveId(source, importer) {
      if (source === 'src/index.ts') {
        logTrace(`resolveId source=${source} importer=${importer ?? 'entry'}`);
      }
      return null;
    },
    transform(_, id) {
      transformCount += 1;
      if (transformCount === 1 || transformCount % 25 === 0) {
        logTrace(`transform count=${transformCount} file=${id}`);
      }
      return null;
    },
    buildEnd(error) {
      if (error) {
        logTrace(`buildEnd with error=${error.message}`);
      } else {
        logTrace('buildEnd');
      }
    },
    outputOptions() {
      logTrace('outputOptions');
      return null;
    },
    renderStart() {
      logTrace('renderStart');
    },
    generateBundle() {
      logTrace('generateBundle');
    },
    writeBundle() {
      logTrace('writeBundle');
    },
    closeBundle() {
      logTrace('closeBundle');
    },
  };
}

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
      exports: 'auto',
      interop: 'compat',
      // Fix: avoid _interopNamespaceCompat crash when processing Node.js built-ins
      // (path, child_process, etc.) that have inherited prototype properties.
      // getOwnPropertyDescriptor returns undefined for inherited props → d.get throws.
      externalLiveBindings: false,
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
      typeDefsTracePlugin(),
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
