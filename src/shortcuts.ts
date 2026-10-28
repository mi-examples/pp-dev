import type { ViteDevServer } from 'vite';
import { createLogger } from './lib/logger.js';
import { colors } from './lib/helpers/color.helper.js';

export function isDefined<T>(value: T | undefined | null | false): value is T {
  return value !== null && value !== undefined && value !== false;
}

export type BindShortcutsOptions = {
  /**
   * Print a one line hint to the terminal.
   */
  print?: boolean;
  customShortcuts?: (CLIShortcut | undefined | null)[];
};

export type CLIShortcut = {
  key: string;
  description: string;
  action(server: ViteDevServer): void | Promise<void>;
};

let cleanupActiveShortcutBinding: (() => void) | null = null;

/** The options each server's shortcuts were bound with, to bind them again after a restart. */
const boundOptions = new WeakMap<ViteDevServer, BindShortcutsOptions>();

/**
 * Ctrl+C in raw mode arrives as input, so the CLI's SIGINT handlers (graceful shutdown) have to be
 * run by hand. `process.kill(pid, 'SIGINT')` does that on POSIX, but on Windows it terminates the
 * process at once (TerminateProcess) without running any handler; emitting the event runs them.
 */
export function interruptProcess(proc: Pick<NodeJS.Process, 'platform' | 'pid' | 'kill' | 'emit'> = process): void {
  if (proc.platform === 'win32') {
    proc.emit('SIGINT', 'SIGINT');
  } else {
    proc.kill(proc.pid, 'SIGINT');
  }
}

export function bindShortcuts(server: ViteDevServer, opts: BindShortcutsOptions): void {
  if (!server.httpServer || !process.stdin.isTTY || process.env.CI) {
    return;
  }

  boundOptions.set(server, opts);

  const logger = createLogger();

  if (opts.print) {
    logger.info(
      colors.dim(colors.green('  ➜')) + colors.dim('  press ') + colors.bold('h') + colors.dim(' to show help'),
    );
  }

  const shortcuts = (opts.customShortcuts ?? []).filter(isDefined).concat(BASE_SHORTCUTS);

  // Ensure previous server bindings are fully detached before rebinding.
  cleanupActiveShortcutBinding?.();
  cleanupActiveShortcutBinding = null;

  let actionRunning = false;
  const wasPaused = process.stdin.isPaused();
  const stdinWithRawMode = process.stdin as NodeJS.ReadStream & {
    isRaw?: boolean;
  };
  const hadRawModeEnabled = Boolean(stdinWithRawMode.isRaw);

  const onInput = async (input: string) => {
    // ctrl+c or ctrl+d
    if (input === '\x03') {
      // Raise SIGINT so the CLI's graceful shutdown handlers run.
      interruptProcess();

      return;
    }

    if (input === '\x04') {
      await server.close().finally(() => process.exit(0));

      return;
    }

    if (actionRunning) {
      return;
    }

    if (input === 'h') {
      logger.info(
        [
          '',
          colors.bold('  Shortcuts'),
          ...shortcuts.map(
            (shortcut) =>
              colors.dim('  press ') + colors.bold(shortcut.key) + colors.dim(` to ${shortcut.description}`),
          ),
        ].join('\n'),
      );
    }

    const shortcut = shortcuts.find((shortcut) => shortcut.key === input);

    if (!shortcut) {
      return;
    }

    actionRunning = true;
    await shortcut.action(server);
    actionRunning = false;
  };

  process.stdin.setRawMode(true);

  process.stdin.on('data', onInput).setEncoding('utf8').resume();

  const boundServer = server.httpServer;

  const cleanupBinding = () => {
    if (cleanupActiveShortcutBinding !== cleanupBinding) {
      return;
    }

    boundServer.removeListener('close', cleanupBinding);
    process.stdin.off('data', onInput);

    if (!hadRawModeEnabled) {
      process.stdin.setRawMode(false);
    }

    if (wasPaused) {
      process.stdin.pause();
    }

    cleanupActiveShortcutBinding = null;
  };

  cleanupActiveShortcutBinding = cleanupBinding;
  boundServer.on('close', cleanupBinding);
}

const BASE_SHORTCUTS: CLIShortcut[] = [
  {
    key: 'r',
    description: 'restart the server',
    async action(server) {
      const opts = boundOptions.get(server);

      await server.restart();

      // Our stdin listener goes with the old HTTP server, and Vite only binds its own shortcuts
      // again: bind ours to the restarted server (same object, new HTTP server).
      if (opts) {
        bindShortcuts(server, { ...opts, print: false });
      }
    },
  },
  {
    key: 'u',
    description: 'show server url',
    action(server) {
      server.config.logger.info('');
      server.printUrls();
    },
  },
  {
    key: 'o',
    description: 'open in browser',
    action(server) {
      server.openBrowser();
    },
  },
  {
    key: 'c',
    description: 'clear console',
    action(server) {
      server.config.logger.clearScreen('error');
    },
  },
  {
    key: 'q',
    description: 'quit',
    async action(server) {
      await server.close().finally(() => process.exit());
    },
  },
  {
    key: 'C',
    description: 'clear proxy cache',
    action(server: ViteDevServer): void | Promise<void> {
      if (server.cache) {
        server.cache.clear();

        server.config.logger.info('Proxy cache cleared');
      }
    },
  },
];
