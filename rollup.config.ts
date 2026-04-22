// @ts-nocheck
import { defineConfig } from 'rollup';
import typescript from '@rollup/plugin-typescript';
import dts from 'rollup-plugin-dts';
import terser from '@rollup/plugin-terser';
import * as path from 'path';
import * as fs from 'fs';
import { builtinModules } from 'module';

// Read package.json safely
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));

// Common external dependencies
const externalDeps = [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
  // Exclude dev dependencies from external as they shouldn't be bundled
];

const nodeBuiltins = new Set(builtinModules.flatMap((mod) => [mod, `node:${mod}`]));
const additionalExternal = new Set(['postcss', 'rollup', 'vite', 'estree']);

const isExternal = (id) => {
  if (nodeBuiltins.has(id)) {
    return true;
  }

  if (externalDeps.includes(id)) {
    return true;
  }

  if (additionalExternal.has(id)) {
    return true;
  }

  return externalDeps.some((dep) => id.startsWith(`${dep}/`));
};

const defaultConfig = {
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

function typeDefsMonitorPlugin() {
  const timeoutMs = Number(process.env.PP_DEV_DTS_TIMEOUT_MS ?? 120_000);
  const heartbeatMs = Number(process.env.PP_DEV_DTS_HEARTBEAT_MS ?? 10_000);

  let buildStartedAt = 0;
  let heartbeat = null;
  let timeout = null;

  const clearTimers = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }

    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  };

  return {
    name: 'type-defs-monitor',
    buildStart() {
      buildStartedAt = Date.now();
      console.info(`[rollup:dts] build started (timeout=${timeoutMs}ms heartbeat=${heartbeatMs}ms)`);

      heartbeat = setInterval(() => {
        const elapsedMs = Date.now() - buildStartedAt;

        console.info(`[rollup:dts] still building... elapsed=${elapsedMs}ms`);
      }, heartbeatMs);
      heartbeat.unref?.();

      timeout = setTimeout(() => {
        const elapsedMs = Date.now() - buildStartedAt;

        console.error(`[rollup:dts] build exceeded timeout after ${elapsedMs}ms, aborting`);
        process.exit(1);
      }, timeoutMs);
      timeout.unref?.();
    },
    buildEnd(error) {
      clearTimers();

      const elapsedMs = Date.now() - buildStartedAt;

      if (error) {
        console.error(`[rollup:dts] build failed after ${elapsedMs}ms: ${error.message}`);
      } else {
        console.info(`[rollup:dts] build completed in ${elapsedMs}ms`);
      }
    },
    closeBundle() {
      clearTimers();
    },
  };
}

const configs = [
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
    external: isExternal,
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
    external: isExternal,
    preserveEntrySignatures: 'strict',
  }),

  // Type Definitions
  defineConfig({
    input: 'src/index.ts',
    plugins: [
      typeDefsMonitorPlugin(),
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
  }),
];

export default configs;
