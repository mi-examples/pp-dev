import * as path from 'path';
import {
  type InlineConfig,
  type LogLevel,
  type ViteDevServer,
  loadConfigFromFile,
  mergeConfig,
  normalizePath,
} from 'vite';
import { getViteConfig } from '../index.js';
import { loadPPDevEnv } from '../lib/env.js';
import type { ResolvedBuildCliOverrides } from '../lib/build-cli-overrides.js';
import { envFilesForMode } from './config-watcher.js';

export interface CommandViteConfigOptions {
  /** The `[root]` argument of the command. */
  root: string | undefined;
  mode: string;
  /** Which `vite.config.*` variant to load: what a config function sees as `command`. */
  command: 'build' | 'serve';
  /** `preview`: `serve` with `isPreview`, as Vite resolves it. */
  isPreview?: boolean;
  /** `build --ssr`: what a config function sees as `isSsrBuild`. */
  ssr?: boolean;
  /** `--config`. */
  configFile: string | undefined;
  logLevel: LogLevel | undefined;
  buildOverrides?: ResolvedBuildCliOverrides;
}

/**
 * The Vite config a command starts from: the `.env` files of `mode` loaded, pp-dev's config
 * ({@link getViteConfig}), and the project's `vite.config.*` merged over it, plugins included.
 * `serve`, `build`, `optimize` and `preview` each had a copy of this.
 *
 * The commands pass this to Vite with `configFile: false`: given the file too, Vite loaded it a
 * second time and merged it under the inline config, so its arrays (`server.allowedHosts`,
 * `optimizeDeps.include`, `build.rollupOptions.external`) held every entry twice, a config function
 * with side effects ran twice, and under `pp-dev` Vite restarted on its own when the file changed,
 * with the plugin instance and the pp-dev config of the first start, before pp-dev's own restart.
 */
export interface CommandViteConfig {
  config: InlineConfig;
  /** The project root: where pp-dev's `.env` files are. */
  envDir: string;
  /** The `vite.config.*` loaded, with the files it imports: a change to any of them is a config change. */
  configFile: { path: string; dependencies: string[] } | null;
  /** The `.env` files Vite itself loads for `mode`, in its `envDir` (none with `envDir: false`). */
  viteEnvFiles: string[];
}

export async function loadCommandViteConfig(opts: CommandViteConfigOptions): Promise<CommandViteConfig> {
  const { root, mode, command, isPreview } = opts;
  const envDir = path.resolve(process.cwd(), root ?? '.');

  loadPPDevEnv(mode, envDir);

  const configFromFile = await loadViteConfigFile(opts);

  let config = await getViteConfig(opts.buildOverrides, { mode, root: envDir });

  if (configFromFile) {
    config = mergeConfig(config, configFromFile.config);
  }

  // As Vite resolves them: its root — the command's `[root]` when given (the inline config's, over
  // the file's), else the file's `root`, else the current directory — and `envDir` against it.
  const viteRoot = root ? envDir : config.root ? path.resolve(config.root) : envDir;
  const viteEnvDir = config.envDir === false ? null : path.resolve(viteRoot, config.envDir ?? '.');

  return {
    config,
    envDir,
    configFile: configFromFile ? { path: configFromFile.path, dependencies: configFromFile.dependencies } : null,
    viteEnvFiles: viteEnvDir ? envFilesForMode(mode).map((name) => path.join(viteEnvDir, name)) : [],
  };
}

/**
 * Loads the project's `vite.config.*` as Vite's own load of it did, the one the commands now pass
 * up (`configFile: false`): `isSsrBuild` for `build --ssr`, and `NODE_ENV` as Vite defaults it for
 * the command (`production` for a build and a preview, `development` otherwise) when none is set —
 * Vite sets it only once it resolves the config, after this load, so a plugin a config enables for
 * `process.env.NODE_ENV === 'production'` was left out of the build. The value is taken back after
 * the load: Vite then decides it as it would have (a `.env` file's `NODE_ENV=development` included).
 */
async function loadViteConfigFile(opts: CommandViteConfigOptions) {
  const { mode, command, isPreview } = opts;
  const defaultNodeEnv = command === 'build' || isPreview ? 'production' : 'development';
  const setNodeEnv = process.env.NODE_ENV === undefined;

  if (setNodeEnv) {
    Object.assign(process.env, { NODE_ENV: defaultNodeEnv });
  }

  try {
    return await loadConfigFromFile(
      {
        mode,
        command,
        isSsrBuild: command === 'build' && opts.ssr === true,
        ...(isPreview ? { isPreview } : {}),
      },
      opts.configFile,
      opts.root,
      opts.logLevel,
    );
  } finally {
    if (setNodeEnv) {
      Reflect.deleteProperty(process.env, 'NODE_ENV');
    }
  }
}

/**
 * The `.env` files a Vite dev server loads, as it resolved them: its `mode` (the config file's when
 * the command gave none) and its `envDir` (after the plugins' config hooks); none for
 * `envDir: false`. In Vite's form (forward slashes), as its watcher holds them.
 */
export function viteEnvFilesOf(config: { mode: string; envDir: string | false }): string[] {
  const { envDir } = config;

  return envDir === false ? [] : envFilesForMode(config.mode).map((name) => normalizePath(path.join(envDir, name)));
}

/**
 * Takes the `.env` files of `server` from its own watcher, as resolved (see {@link viteEnvFilesOf}),
 * and returns them for pp-dev's watcher: on a change Vite restarted itself with the config and
 * plugin instances of the start, and the list known before the server existed can miss them (a
 * `mode` set in the config file, an `envDir` a plugin's config hook set).
 */
export function takeViteEnvFiles(server: Pick<ViteDevServer, 'config' | 'watcher'>): string[] {
  const files = viteEnvFilesOf(server.config);

  if (files.length > 0) {
    server.watcher.unwatch(files);
  }

  return files;
}
