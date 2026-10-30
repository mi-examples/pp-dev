import * as path from 'path';
import { type InlineConfig, type LogLevel, loadConfigFromFile, mergeConfig } from 'vite';
import { getViteConfig } from '../index.js';
import { loadPPDevEnv } from '../lib/env.js';
import type { ResolvedBuildCliOverrides } from '../lib/build-cli-overrides.js';

export interface CommandViteConfigOptions {
  /** The `[root]` argument of the command. */
  root: string | undefined;
  mode: string;
  /** Which `vite.config.*` variant to load. */
  command: 'build' | 'serve';
  /** `--config`. */
  configFile: string | undefined;
  logLevel: LogLevel | undefined;
  buildOverrides?: ResolvedBuildCliOverrides;
}

/**
 * The Vite config a command starts from: the `.env` files of `mode` loaded, pp-dev's config
 * ({@link getViteConfig}), and the project's `vite.config.*` merged over it without its plugins.
 * `serve`, `build`, `optimize` and `preview` each had a copy of this.
 */
export async function loadCommandViteConfig(
  opts: CommandViteConfigOptions,
): Promise<{ config: InlineConfig; envDir: string }> {
  const { root, mode, command } = opts;
  const envDir = path.resolve(process.cwd(), root ?? '.');

  loadPPDevEnv(mode, envDir);

  const configFromFile = await loadConfigFromFile({ mode, command }, opts.configFile, root, opts.logLevel);

  let config = await getViteConfig(opts.buildOverrides, { mode, root: envDir });

  if (configFromFile) {
    const fileConfig = { ...configFromFile.config };

    delete fileConfig.plugins;
    config = mergeConfig(config, fileConfig);
  }

  return { config, envDir };
}
