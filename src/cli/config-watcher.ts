import * as fs from 'fs';
import * as path from 'path';
import { watch } from 'chokidar';
import { colors } from '../lib/helpers/color.helper.js';
import { PP_DEV_CONFIG_NAMES } from '../constants.js';

// Config file watcher utility
export interface ConfigWatcher {
  watcher: ReturnType<typeof watch>;
  /** Settles once changes are seen: a change before that is missed, so the start is logged then. */
  ready: Promise<void>;
  /** Watches `files` too (see {@link ConfigWatcherOptions.files}); ones already watched are left as they are. */
  add(files: string[]): void;
  /** Closes the watcher; a restart it had scheduled is dropped, one it is running finishes. */
  close(): Promise<void>;
}

export interface ConfigWatcherOptions {
  /** How long after the last change the restart runs, so one save (editors write several times) restarts once. @default 500 */
  debounceMs?: number;
  /** The mode whose `.env` files the server loads (`--mode`), watched with `.env` and `.env.local`. @default 'development' */
  mode?: string;
  /**
   * Files to watch besides the config files in the project root, wherever they are: a `--config`
   * elsewhere and the modules it imports, the `.env` files of Vite's own `envDir`. Only ones that
   * exist: chokidar given a path that doesn't delivers nothing, not even the root's changes (seen
   * with the `.env` names that are usually absent).
   */
  files?: string[];
}

/** The paths that exist, resolved: what chokidar may be given. */
function existingFiles(files: string[]): string[] {
  return files.map((file) => path.resolve(file)).filter((file) => fs.existsSync(file));
}

/** The files in the project root whose change restarts the dev server, besides the `.env` files of the mode. */
export const WATCHED_CONFIG_FILES: readonly string[] = [
  ...PP_DEV_CONFIG_NAMES,
  'package.json',
  'next.config.js',
  'next.config.mjs',
  'next.config.cjs',
  'next.config.ts',
  'next.config.mts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.cts',
];

/** The `.env` files the dev server loads for `mode`, as Vite's `loadEnv()` does: a change to one is a config change. */
export function envFilesForMode(mode = 'development'): string[] {
  return ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`];
}

/** The files in the project root whose change restarts a dev server running in `mode`. */
export function watchedConfigFiles(mode = 'development'): string[] {
  return [...WATCHED_CONFIG_FILES, ...envFilesForMode(mode)];
}

function describeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/**
 * Restarts the dev server (`restartCallback`) when a config file in `projectRoot` changes, is
 * created or removed.
 *
 * The root directory is watched (one level, the config names filtered): chokidar drops a path that
 * doesn't exist when the watch starts, so a `.env.local` or config file created later was never
 * seen, nor was a removed one.
 *
 * Restarts run one at a time. A change that comes while one is running (a restart takes seconds, a
 * save a format-on-save later came within them) runs another once it is done, instead of being
 * lost with the first restart's config kept.
 */
export function createConfigWatcher(
  projectRoot: string,
  restartCallback: () => Promise<void>,
  logger: (message: string) => void,
  options: ConfigWatcherOptions = {},
): ConfigWatcher {
  const { debounceMs = 500, mode, files = [] } = options;
  const root = path.resolve(projectRoot);
  const watchedFiles = new Set(watchedConfigFiles(mode));
  const extraFiles = new Set(existingFiles(files));

  const watcher = watch([root, ...extraFiles], {
    // Without stats chokidar is asking about a path it hasn't looked at yet: let it look. With them,
    // the root itself, the config files in it and the files given pass; other files and every
    // directory are ignored.
    ignored: (filePath, stats) => {
      if (!stats) {
        return false;
      }

      if (stats.isDirectory()) {
        return path.resolve(filePath) !== root;
      }

      const resolved = path.resolve(filePath);

      return (
        !extraFiles.has(resolved) && !(path.dirname(resolved) === root && watchedFiles.has(path.basename(resolved)))
      );
    },
    depth: 0,
    persistent: true,
    ignoreInitial: true,
    followSymlinks: false,
  });

  let restartTimeout: NodeJS.Timeout | null = null;
  let restarting = false;
  let restartRequested = false;
  let closed = false;

  const runRestart = async () => {
    restartTimeout = null;

    if (closed) {
      return;
    }

    if (restarting) {
      restartRequested = true;

      return;
    }

    restarting = true;

    try {
      logger(colors.yellow(`🔄 Restarting dev server due to config change...`));
      await restartCallback();
    } catch (error) {
      logger(colors.red(`❌ Failed to restart dev server: ${describeError(error)}`));
    } finally {
      restarting = false;
    }

    if (restartRequested && !closed) {
      restartRequested = false;
      logger(colors.blue(`🔧 Config changed again during the restart`));
      scheduleRestart();
    }
  };

  const scheduleRestart = () => {
    if (restartTimeout) {
      clearTimeout(restartTimeout);
    }

    restartTimeout = setTimeout(() => void runRestart(), debounceMs);
  };

  const onChange = (event: string) => (filePath: string) => {
    logger(colors.blue(`🔧 Config file ${event}: ${path.relative(root, filePath)}`));
    scheduleRestart();
  };

  watcher.on('change', onChange('changed'));
  watcher.on('add', onChange('added'));
  watcher.on('unlink', onChange('removed'));

  watcher.on('error', (error) => {
    logger(colors.red(`❌ Config watcher error: ${describeError(error)}`));
  });

  const ready = new Promise<void>((resolve) => {
    watcher.once('ready', () => {
      logger(colors.blue('🔧 Config file watcher started'));
      resolve();
    });
  });

  return {
    watcher,
    ready,
    add(paths) {
      const added = existingFiles(paths).filter((file) => !extraFiles.has(file));

      for (const file of added) {
        extraFiles.add(file);
      }

      if (added.length > 0 && !closed) {
        watcher.add(added);
      }
    },
    async close() {
      closed = true;

      if (restartTimeout) {
        clearTimeout(restartTimeout);
        restartTimeout = null;
      }

      await watcher.close();
    },
  };
}

export function cleanupConfigWatcher(watcher: ConfigWatcher): Promise<void> {
  return watcher.close();
}
