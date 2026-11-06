import * as path from 'path';
import { type InlineConfig, type LogLevel, loadConfigFromFile, mergeConfig } from 'vite';
import { getViteConfig } from '../index.js';
import { loadPPDevEnv } from '../lib/env.js';
import type { ResolvedBuildCliOverrides } from '../lib/build-cli-overrides.js';

export interface CommandViteConfigOptions {
  /** The `[root]` argument of the command. */
  root: string | undefined;
  mode: string;
  /** Which `vite.config.*` variant to load: what a config function sees as `command`. */
  command: 'build' | 'serve';
  /** `preview`: `serve` with `isPreview`, as Vite resolves it. */
  isPreview?: boolean;
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
export async function loadCommandViteConfig(
  opts: CommandViteConfigOptions,
): Promise<{ config: InlineConfig; envDir: string }> {
  const { root, mode, command, isPreview } = opts;
  const envDir = path.resolve(process.cwd(), root ?? '.');

  loadPPDevEnv(mode, envDir);

  const configFromFile = await loadConfigFromFile(
    { mode, command, ...(isPreview ? { isPreview } : {}) },
    opts.configFile,
    root,
    opts.logLevel,
  );

  let config = await getViteConfig(opts.buildOverrides, { mode, root: envDir });

  if (configFromFile) {
    config = mergeConfig(config, configFromFile.config);
  }

  return { config, envDir };
}
