import { BuildOptions, LogLevel } from 'vite';

export function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface PPDevBuildOptions extends BuildOptions {
  changelog?: boolean | string;
}

// global options
export interface GlobalCLIOptions {
  '--'?: string[];
  c?: boolean | string;
  config?: string;
  base?: string;
  l?: LogLevel;
  logLevel?: LogLevel;
  clearScreen?: boolean;
  d?: boolean | string;
  debug?: boolean | string;
  f?: string;
  filter?: string;
  m?: string;
  mode?: string;
  force?: boolean;
}

/** Extra flags for `pp-dev next` (Next.js custom server bundler selection; Next 15+). */
export interface NextCommandCLIOptions extends GlobalCLIOptions {
  /** Use Webpack for dev (same idea as `next dev --webpack`). */
  webpack?: boolean;
  /** Use Turbopack when native bindings are available. */
  turbopack?: boolean;
}

export type NextBundlerChoice = { webpack?: boolean; turbopack?: boolean };

export function parseNextBundlerCli(opts: NextCommandCLIOptions): NextBundlerChoice {
  const envWebpack = process.env.PP_DEV_NEXT_WEBPACK === '1' || process.env.PP_DEV_NEXT_WEBPACK === 'true';

  if (envWebpack && (opts.webpack || opts.turbopack)) {
    throw new Error('Do not combine PP_DEV_NEXT_WEBPACK with --webpack or --turbopack');
  }

  if (envWebpack) {
    return { webpack: true };
  }

  if (opts.webpack && opts.turbopack) {
    throw new Error('Use only one of --webpack or --turbopack');
  }

  if (opts.webpack) {
    return { webpack: true };
  }

  if (opts.turbopack) {
    return { turbopack: true };
  }

  return {};
}

/** Next dev chose Turbopack but native @next/swc bindings failed (e.g. WDAC on Windows). */
export function isNextTurbopackNativeBindingsError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('message' in error)) {
    return false;
  }

  const msg = String((error as Error).message);

  return (
    /Turbopack is not supported/i.test(msg) ||
    /native bindings are not available/i.test(msg) ||
    /Only WebAssembly \(WASM\) bindings were loaded/i.test(msg)
  );
}

export const filterDuplicateOptions = <T extends object>(options: T) => {
  for (const [key, value] of Object.entries(options)) {
    if (Array.isArray(value)) {
      options[key as keyof T] = value[value.length - 1];
    }
  }
};
