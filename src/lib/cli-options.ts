/**
 * Turning the CLI's flags into what Vite and Next.js are given. Kept apart from `cli.ts`, which
 * starts the CLI when imported, so these can be tested.
 */

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
 * that name.
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

  const parsedPort = typeof port === 'number' ? port : typeof port === 'string' ? Number.parseInt(port, 10) : NaN;

  return { host: resolvedHost, port: Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : 3000 };
}
