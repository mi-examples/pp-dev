import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import JSZip from 'jszip';

// Mock only child_process.spawn so `next build` is simulated (no real Next.js build),
// while keeping the rest (execSync used by version-manifest git lookup) intact.
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();

  return { ...actual, spawn: spawnMock };
});

const { DistService } = await import('../../../src/lib/dist.service.js');
const { createLogger } = await import('../../../src/lib/logger.js');
const { PP_DEV_NEXT_BUILD_DIST_DIR_ENV_VAR } = await import('../../../src/constants.js');

type NextBuildOptions = NonNullable<ConstructorParameters<typeof DistService>[1]>['nextBuild'];

// The sync meta and backups of these services, outside the repository and the Next.js output.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-next-state-'));
const state = { backupFolder: path.join(stateDir, 'backups'), metaDir: path.join(stateDir, '.pp-dev-meta') };

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/**
 * A Next.js app as `pp-dev next` leaves it: `output: 'export'` with `distDir: 'dist'`, so the dev
 * server writes under `dist/dev` (its manifests, its route types). The sync's build runner resolves
 * `next` from the app; the build itself is the spawn mock's.
 */
function makeProject(devDistDir = 'dist'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-next-project-'));

  fs.mkdirSync(path.join(root, 'node_modules', 'next'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'next', 'package.json'), '{"name":"next","version":"0.0.0"}');
  fs.mkdirSync(path.join(root, devDistDir, 'dev', 'types'), { recursive: true });
  fs.writeFileSync(path.join(root, devDistDir, 'dev', 'app-paths-manifest.json'), '{}');
  fs.writeFileSync(path.join(root, devDistDir, 'dev', 'types', 'validator.ts'), 'type PagesPageConfig = {};');

  return root;
}

function writeExport(dir: string) {
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(dir, '_next', 'static', 'media'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>app</body></html>');
  fs.writeFileSync(path.join(dir, 'next.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  fs.writeFileSync(path.join(dir, 'sub', 'app.js'), 'console.log(1)');
  fs.writeFileSync(
    path.join(dir, '_next', 'static', 'media', 'next.0x5qb3h5j23ox.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1" /></svg>',
  );
}

/** What the spawn mock saw of a `next build`: its environment, and the project at that moment. */
interface BuildSeen {
  env: NodeJS.ProcessEnv;
  devTypesPresent: boolean;
}

/**
 * Simulates `next build` as Next.js runs it for a static export: the export goes to the configured
 * distDir (`out` for the default `.next`), which is emptied first. The distDir is the app's
 * (`dist`, or `configured`), unless the build is given another one through the environment, as
 * `withPPDev()` applies it.
 */
function simulateBuild(
  root: string,
  seen: BuildSeen[],
  {
    exitCode = 0,
    exports = true,
    configured = 'dist',
  }: { exitCode?: number; exports?: boolean; configured?: string } = {},
) {
  spawnMock.mockImplementation((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    const proc: any = new EventEmitter();
    const distDir = options.env[PP_DEV_NEXT_BUILD_DIST_DIR_ENV_VAR] ?? configured;
    const exportDir = path.join(root, distDir === '.next' ? 'out' : distDir);

    seen.push({ env: options.env, devTypesPresent: fs.existsSync(path.join(root, 'dist', 'dev', 'types')) });

    if (exitCode === 0 && exports) {
      fs.rmSync(exportDir, { recursive: true, force: true });
      writeExport(exportDir);
    }

    setImmediate(() => proc.emit('close', exitCode));

    return proc;
  });
}

describe('DistService — Next.js build strategy', () => {
  let root: string;
  let builds: BuildSeen[];

  beforeEach(() => {
    root = makeProject();
    builds = [];
    simulateBuild(root, builds);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function createService(nextBuild: Partial<NextBuildOptions> = {}) {
    return new DistService('test-app', {
      ...state,
      nextBuild: {
        projectRoot: root,
        distDir: 'dist',
        output: 'export',
        configWrapped: true,
        packageVersion: '1.2.3',
        ...nextBuild,
      },
    });
  }

  it('runs `next build` (not pp-dev build) and zips the export directory', async () => {
    const buf = await createService().buildNewAssets();

    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('build');
    expect(String(args[0])).toMatch(/next/);

    const zip = await JSZip.loadAsync(buf);

    expect(zip.file('index.html')).toBeTruthy();
    expect(zip.file('sub/app.js')).toBeTruthy();
  });

  // The build exported into the app's distDir, which `next build` empties first: the dev server
  // lost its manifests and cache under `dist/dev` on every sync.
  it("builds apart from the dev server's files: Next's default distDir, exported to `out`", async () => {
    const buf = await createService().buildNewAssets();

    expect(builds[0].env[PP_DEV_NEXT_BUILD_DIST_DIR_ENV_VAR]).toBe('.next');
    expect(fs.existsSync(path.join(root, 'out', 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'dist', 'dev', 'app-paths-manifest.json'))).toBe(true);

    const zip = await JSZip.loadAsync(buf);

    expect(zip.file('index.html')).toBeTruthy();
  });

  // The dev server's route types and the build's own declare the same globals, and the app's
  // tsconfig includes both: a build after any dev session failed on "Duplicate identifier".
  it("removes the dev server's route types before the build", async () => {
    const info = vi.spyOn(createLogger(), 'info');

    await createService().buildNewAssets();

    expect(builds[0].devTypesPresent).toBe(false);
    expect(info.mock.calls.map(String).join('\n')).toContain('Removed stale dev route types');
  });

  it('leaves the route types alone when the app is no static export', async () => {
    await createService({ output: undefined }).buildNewAssets();

    expect(builds[0].devTypesPresent).toBe(true);
  });

  it('builds in place for a next.config without withPPDev(), and says what that costs', async () => {
    const warn = vi.spyOn(createLogger(), 'warn');
    const buf = await createService({ configWrapped: false }).buildNewAssets();

    expect(builds[0].env).not.toHaveProperty(PP_DEV_NEXT_BUILD_DIST_DIR_ENV_VAR);
    expect(fs.existsSync(path.join(root, 'out'))).toBe(false);
    expect(warn.mock.calls.map(String).join('\n')).toContain('not wrapped with withPPDev()');

    const zip = await JSZip.loadAsync(buf);

    expect(zip.file('index.html')).toBeTruthy();
  });

  // A config function may give the production phase another distDir than the development one:
  // the route types are the development directory's, the export the production directory's.
  it("builds in place where the production phase's distDir says, not the dev server's", async () => {
    fs.rmSync(root, { recursive: true, force: true });
    root = makeProject('dev-cache');
    simulateBuild(root, builds, { configured: 'release' });

    const buf = await createService({
      configWrapped: false,
      distDir: 'dev-cache',
      buildDistDir: 'release',
    }).buildNewAssets();

    expect(builds[0].devTypesPresent).toBe(false);
    expect(fs.existsSync(path.join(root, 'dev-cache', 'dev', 'types'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'release', 'index.html'))).toBe(true);

    const zip = await JSZip.loadAsync(buf);

    expect(zip.file('index.html')).toBeTruthy();
  });

  it('includes VERSION and BUILD-MANIFEST files in the zip for sync parity', async () => {
    const buf = await createService().buildNewAssets();
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files);

    expect(names.some((n) => /^VERSION-v1\.2\.3-.*\.json$/.test(n))).toBe(true);
    expect(zip.file('BUILD-MANIFEST.json')).toBeTruthy();
  });

  it('produces a VERSION manifest whose hashes match the built files (round-trip)', async () => {
    const service = createService();
    const buf = await service.buildNewAssets();

    // Analyzing the freshly built zip must report no inconsistencies: the VERSION
    // file content (hashes) matches every built file, including SVGs.
    const analysis = await service.analyzeBackup(buf);

    expect(analysis.versionManifestHashMismatches).toEqual([]);
    expect(analysis.unknownFiles).toEqual([]);
    expect(analysis.buildManifestMismatch).toBeNull();
  });

  // `next build` empties the export directory: with the app's distDir in it, the dev server's
  // manifests and cache went with it.
  it("rejects before building when the app's distDir is inside the sync's export directory", async () => {
    fs.rmSync(root, { recursive: true, force: true });
    root = makeProject('out');
    simulateBuild(root, builds, { configured: 'out' });

    await expect(createService({ distDir: 'out' }).buildNewAssets()).rejects.toThrow(
      /distDir \(out\) is inside the sync's export directory \(out\)/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, 'out', 'dev', 'app-paths-manifest.json'))).toBe(true);
  });

  // A previous sync's `out/` was uploaded again after `output: 'export'` was dropped from next.config.
  it("does not upload a previous sync's export when this build leaves none", async () => {
    writeExport(path.join(root, 'out'));
    simulateBuild(root, builds, { exports: false });

    await expect(createService().buildNewAssets()).rejects.toThrow(/output directory not found/);
    expect(fs.existsSync(path.join(root, 'out'))).toBe(false);
  });

  it('rejects when `next build` exits non-zero', async () => {
    simulateBuild(root, builds, { exitCode: 1 });

    await expect(createService().buildNewAssets()).rejects.toThrow(/next build exited with code 1/);
  });

  it('rejects, saying what the sync needs, when the build leaves no static export', async () => {
    simulateBuild(root, builds, { exports: false });

    await expect(createService().buildNewAssets()).rejects.toThrow(/output directory not found.*output: 'export'/);
  });
});

/**
 * The steps after `next build` (the manifest hashes the whole output, then the ZIP) take a while.
 * A dev server stopped (or restarted) meanwhile still got assets from them, and its sync uploaded them.
 */
describe('DistService — stopped right after the Next.js build', () => {
  it('neither writes the manifest nor returns assets', async () => {
    const root = makeProject();

    try {
      simulateBuild(root, []);

      const service = new DistService('test-app', {
        ...state,
        nextBuild: {
          projectRoot: root,
          distDir: 'dist',
          output: 'export',
          configWrapped: true,
          packageVersion: '1.2.3',
        },
      });
      // The build has just finished when this is logged: the server stops at that moment.
      const info = vi.spyOn(createLogger(), 'info').mockImplementation((message: string) => {
        if (String(message).includes('Next.js build finished')) {
          service.stopBuilds();
        }
      });

      try {
        await expect(service.buildNewAssets()).rejects.toThrow('next build was stopped');
      } finally {
        info.mockRestore();
      }

      expect(fs.existsSync(path.join(root, 'out', 'BUILD-MANIFEST.json'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
