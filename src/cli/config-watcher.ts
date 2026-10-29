import * as path from 'path';
import { watch } from 'chokidar';
import { colors } from '../lib/helpers/color.helper.js';
import { PP_DEV_CONFIG_NAMES } from '../constants.js';

// Config file watcher utility
export interface ConfigWatcher {
  watcher: ReturnType<typeof watch>;
}

export function createConfigWatcher(
  projectRoot: string,
  restartCallback: () => Promise<void>,
  logger: (message: string) => void,
): ConfigWatcher {
  const configFiles = [
    ...PP_DEV_CONFIG_NAMES,
    'package.json',
    'next.config.js',
    'next.config.mjs',
    'next.config.ts',
    'vite.config.js',
    'vite.config.mjs',
    'vite.config.ts',
    '.env',
    '.env.local',
    '.env.development',
    '.env.development.local',
  ];

  const watchPatterns = configFiles.map((file) => path.join(projectRoot, file));

  const watcher = watch(watchPatterns, {
    ignored: (filePath) => {
      const base = path.basename(filePath);

      return (
        /(^|[\/\\])\../.test(filePath) &&
        !base.startsWith('.env') &&
        !base.startsWith('.pp-dev') &&
        !base.startsWith('.pp-watch')
      );
    }, // ignore dotfiles except .env*
    persistent: true,
    ignoreInitial: true,
    followSymlinks: false,
  });

  let restartTimeout: NodeJS.Timeout | null = null;

  watcher.on('change', (filePath) => {
    logger(colors.blue(`🔧 Config file changed: ${path.relative(projectRoot, filePath)}`));

    // Debounce restart to avoid multiple rapid restarts
    if (restartTimeout) {
      clearTimeout(restartTimeout);
    }

    restartTimeout = setTimeout(async () => {
      try {
        logger(colors.yellow(`🔄 Restarting dev server due to config change...`));
        await restartCallback();
      } catch (error: any) {
        logger(colors.red(`❌ Failed to restart dev server: ${error?.message}. Stack: ${error?.stack}`));
      }
    }, 500); // 500ms debounce
  });

  watcher.on('error', (error) => {
    logger(colors.red(`❌ Config watcher error: ${error}`));
  });

  return { watcher };
}

export function cleanupConfigWatcher(watcher: ConfigWatcher) {
  if (watcher.watcher) {
    watcher.watcher.close();
  }
}
