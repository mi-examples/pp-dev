import { describe, it, expect } from 'vitest';
import { cleanOptions, resolveNextListenAddress } from '../../../src/lib/cli-options.js';

describe('cleanOptions', () => {
  it("drops global and pp-dev flags, so they don't reach Vite's server / build config as unknown keys", () => {
    const cleaned = cleanOptions({
      '--': [],
      config: 'vite.config.ts',
      c: 'vite.config.ts',
      base: '/x/',
      logLevel: 'warn',
      l: 'warn',
      clearScreen: false,
      configLoader: 'runner',
      profile: true,
      debug: true,
      d: true,
      filter: 'x',
      f: 'x',
      mode: 'staging',
      m: 'staging',
      force: true,
      w: true,
      changelog: 'old.zip',
      distZip: false,
      distZipDir: 'zips',
      distZipFilename: 'app.zip',
      versionManifest: false,
      versionFileTemplate: 'VERSION.json',
      webpack: true,
      turbopack: false,
      host: '0.0.0.0',
      port: 4000,
      outDir: 'build',
    });

    expect(cleaned).toEqual({ host: '0.0.0.0', port: 4000, outDir: 'build' });
  });

  it('turns --watch into the watch options object Vite expects, or nothing', () => {
    expect(cleanOptions({ watch: true })).toEqual({ watch: {} });
    expect(cleanOptions({ watch: false })).toEqual({ watch: undefined });
  });

  it('turns a "true" / "false" --sourcemap into a boolean and keeps "inline" / "hidden"', () => {
    expect(cleanOptions({ sourcemap: 'true' })).toEqual({ sourcemap: true });
    expect(cleanOptions({ sourcemap: 'false' })).toEqual({ sourcemap: false });
    expect(cleanOptions({ sourcemap: 'inline' })).toEqual({ sourcemap: 'inline' });
  });
});

describe('resolveNextListenAddress', () => {
  it.each([
    ['no --host', undefined, 'localhost'],
    ['--host alone (cac gives true)', true, '0.0.0.0'],
    ['--host with an empty value', '', '0.0.0.0'],
    ['--host 127.0.0.1', '127.0.0.1', '127.0.0.1'],
    ['--host my-machine.local', 'my-machine.local', 'my-machine.local'],
    ['--host 0 (cac gives a number)', 0, '0'],
  ])('listens on the right host with %s', (_name, host, expected) => {
    expect(resolveNextListenAddress(host, 3000).host).toBe(expected);
  });

  it.each([
    [3000, 3000],
    [4123, 4123],
    ['4123', 4123],
    [undefined, 3000],
    ['not a port', 3000],
    [-1, 3000],
  ])('reads port %j as %j', (port, expected) => {
    expect(resolveNextListenAddress(undefined, port).port).toBe(expected);
  });
});
