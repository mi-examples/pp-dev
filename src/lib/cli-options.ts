/**
 * Turning the CLI's flags into what Vite and Next.js are given. Kept apart from `cli.ts`, which
 * starts the CLI when imported, so these can be tested.
 */
import path from 'node:path';
import { PP_DEV_CONFIG_FILE_ENV_VAR } from '../constants.js';

/** Flags of every command, or of pp-dev itself: never part of a Vite `server` / `build` config. */
const NON_VITE_FLAGS = [
  '--',
  'c',
  'config',
  'base',
  'l',
  'logLevel',
  'clearScreen',
  'configLoader',
  'profile',
  'd',
  'debug',
  'f',
  'filter',
  'm',
  'mode',
  'env',
  'ppConfig',
  'pp-config',
  // Vite takes it as `optimizeDeps.force`, set separately.
  'force',
  'w',
  // pp-dev build flags (read by the build command itself, see build-cli-overrides).
  'changelog',
  'distZip',
  'distZipDir',
  'distZipFilename',
  'versionManifest',
  'versionFileTemplate',
  // pp-dev next flags.
  'webpack',
  'turbopack',
] as const;

type NonViteFlag = (typeof NON_VITE_FLAGS)[number];

/**
 * The value of the last `--<name> <value>` or `--<name>=<value>` in `argv` (before `--`), as typed:
 * `true` for one without a value, `undefined` without the flag. cac turns a value that looks like a
 * number into one (`--env 01` into `1`, another environment's name) and a repeated flag (a package
 * script's `--env dev`, then `npm run dev -- --env staging`) into an array.
 */
export function lastFlagValue(argv: readonly string[], names: readonly string[]): string | true | undefined {
  let value: string | true | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--') {
      break;
    }

    for (const name of names) {
      if (arg === `--${name}`) {
        const next = argv[i + 1];

        // As cac (mri) reads it: an argument starting with `-` is the next flag, not the value.
        if (next !== undefined && !next.startsWith('-')) {
          value = next;
          i += 1;
        } else {
          value = true;
        }
      } else if (arg.startsWith(`--${name}=`)) {
        value = arg.slice(name.length + 3);
      }
    }
  }

  return value;
}

/**
 * `--env <name>`: the MI environment (`envs` in pp-dev.config), passed on as `MI_ENV`, so what
 * pp-dev starts (the Next.js server process, the build a sync runs) uses it too. Over `MI_ENV` from
 * the shell or a `.env` file. Runs before anything reads the config. Give it the raw value
 * ({@link lastFlagValue}); of a repeated flag, the last one counts.
 */
export function applyEnvOption(value: unknown, env: Record<string, string | undefined> = process.env): void {
  if (Array.isArray(value)) {
    value = value.at(-1);
  }

  if (value === undefined) {
    return;
  }

  const name = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';

  if (!name) {
    throw new Error('--env needs the name of an environment (envs in pp-dev.config, or "default")');
  }

  env.MI_ENV = name;
}

/**
 * `--pp-config <file>`: the pp-dev config to load in place of a `pp-dev.config.*` in the project
 * root, relative to the current directory. Passed on as `PP_DEV_CONFIG` (absolute), as `--env` is.
 * Without the flag, a relative `PP_DEV_CONFIG` from the shell is made absolute: a process pp-dev
 * starts elsewhere (the build a sync runs, in the project root) would read it from there.
 */
export function applyPPConfigOption(
  value: unknown,
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): void {
  if (Array.isArray(value)) {
    value = value.at(-1);
  }

  if (value === undefined) {
    const inherited = env[PP_DEV_CONFIG_FILE_ENV_VAR]?.trim();

    if (inherited) {
      env[PP_DEV_CONFIG_FILE_ENV_VAR] = path.resolve(cwd, inherited);
    }

    return;
  }

  const file = typeof value === 'string' ? value.trim() : '';

  if (!file) {
    throw new Error('--pp-config needs the path of a pp-dev config file');
  }

  env[PP_DEV_CONFIG_FILE_ENV_VAR] = path.resolve(cwd, file);
}

/**
 * The command's own flags, as a Vite `server` or `build` config: without the global and pp-dev
 * flags (they used to leak in as unknown keys), and with `watch` / `sourcemap` converted the way
 * Vite's own CLI does.
 */
export function cleanOptions<Options extends object>(options: Options): Omit<Options, NonViteFlag> {
  const ret = { ...options } as Record<string, unknown>;

  for (const flag of NON_VITE_FLAGS) {
    delete ret[flag];
  }

  if ('sourcemap' in ret) {
    ret.sourcemap = ret.sourcemap === 'true' ? true : ret.sourcemap === 'false' ? false : ret.sourcemap;
  }

  if ('watch' in ret) {
    // `--watch` is a boolean; Vite's `build.watch` is an options object, or nothing to not watch.
    ret.watch = ret.watch ? {} : undefined;
  }

  return ret as Omit<Options, NonViteFlag>;
}

/** Flags `pp-dev next` accepts (copied from `pp-dev`'s Vite server) but has never acted on. */
export const NEXT_IGNORED_FLAGS = ['https', 'open', 'cors', 'strictPort', 'force'] as const;

/**
 * Where `pp-dev next` listens, which is also the hostname Next.js is told. Like `pp-dev`: no
 * `--host` is `localhost`, `--host` alone (cac gives `true`) is every address, `--host <name>` is
 * that name. A `--port` that is no port number is refused, as `pp-dev` (Vite) refuses it; it fell
 * back to 3000 without a word.
 */
export function resolveNextListenAddress(host: unknown, port: unknown): { host: string; port: number } {
  let resolvedHost = 'localhost';

  if (host === true || host === '') {
    resolvedHost = '0.0.0.0';
  } else if (typeof host === 'string') {
    resolvedHost = host;
  } else if (typeof host === 'number') {
    // cac parses `--host 0` as a number.
    resolvedHost = String(host);
  }

  const parsedPort =
    port === undefined
      ? 3000
      : typeof port === 'number'
        ? port
        : typeof port === 'string' && port.trim()
          ? Number(port)
          : NaN;

  if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
    throw new Error(`--port must be a port number (0-65535), got ${JSON.stringify(port)}`);
  }

  return { host: resolvedHost, port: parsedPort };
}
