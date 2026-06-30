import { spawn, execSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockMiServer, type MockMiServer, type MockMode } from '../tests/mock-mi/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const playwrightCli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');

const fixtureDirs = {
  commonjs: path.join(root, 'tests', 'test-commonjs'),
  nextjs: path.join(root, 'tests', 'test-nextjs'),
  'nextjs-cjs': path.join(root, 'tests', 'test-nextjs-cjs'),
} as const;

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  for (const line of fs.readFileSync(filePath, 'utf-8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);

    if (!match || line.trimStart().startsWith('#')) {
      continue;
    }

    const [, key, rawValue = ''] = match;

    process.env[key] ??= unquoteEnvValue(rawValue.replace(/\s+#.*$/, ''));
  }
}

for (const fixtureDir of Object.values(fixtureDirs)) {
  loadEnvFile(path.join(fixtureDir, '.env'));
}

const playwrightArgs = process.argv.slice(2);
const hasWorkerArg = playwrightArgs.some((arg) => arg === '--workers' || arg.startsWith('--workers='));
const defaultPlaywrightArgs = hasWorkerArg ? [] : ['--workers=1'];
const mockMode = (process.env.PP_DEV_E2E_MOCK_MODE ?? 'replay') as MockMode;
const cassetteName = process.env.PP_DEV_E2E_CASSETTE ?? 'startup';
const realMiUrl = process.env.REAL_MI_URL ?? 'https://stg7x.metricinsights.com';

if (mockMode !== 'record' && mockMode !== 'replay') {
  throw new Error(`Unsupported PP_DEV_E2E_MOCK_MODE "${mockMode}". Expected "record" or "replay".`);
}

const defaultFixtureNames = ['commonjs', 'nextjs', 'nextjs-cjs'] as const;
type FixtureName = (typeof defaultFixtureNames)[number];

interface FixtureConfig {
  testType: `dev-${FixtureName}`;
  dir: string;
  configFile: string;
  port: number;
  commandArgs: string[];
}

const fixtureConfigs: Record<FixtureName, FixtureConfig> = {
  commonjs: {
    testType: 'dev-commonjs',
    dir: fixtureDirs.commonjs,
    configFile: 'pp-dev.config.ts',
    port: Number(process.env.PP_DEV_E2E_COMMONJS_PORT ?? 3105),
    commandArgs: [],
  },
  nextjs: {
    testType: 'dev-nextjs',
    dir: fixtureDirs.nextjs,
    configFile: 'pp-dev.config.ts',
    port: Number(process.env.PP_DEV_E2E_NEXTJS_PORT ?? 3106),
    commandArgs: ['next'],
  },
  'nextjs-cjs': {
    testType: 'dev-nextjs-cjs',
    dir: fixtureDirs['nextjs-cjs'],
    configFile: 'pp-dev.config.js',
    port: Number(process.env.PP_DEV_E2E_NEXTJS_CJS_PORT ?? 3107),
    commandArgs: ['next'],
  },
};

const fixtureNames = (process.env.PP_DEV_E2E_FIXTURES ?? defaultFixtureNames.join(','))
  .split(',')
  .map((name) => normalizeFixtureName(name))
  .filter((name, index, names) => names.indexOf(name) === index);

function normalizeFixtureName(value: string): FixtureName {
  const normalized = value.trim().replace(/^dev-/, '') as FixtureName;

  if (!Object.hasOwn(fixtureConfigs, normalized)) {
    throw new Error(`Unknown browser E2E fixture "${value}". Expected one of: ${defaultFixtureNames.join(', ')}`);
  }

  return normalized;
}

function ppDevBinFor(fixtureDir: string): string {
  return path.join(fixtureDir, 'node_modules', '@metricinsights', 'pp-dev', 'bin', 'pp-dev.js');
}

function killTree(proc: ChildProcess): void {
  if (!proc.pid) return;

  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' });
    } catch {
      // already stopped
    }
    return;
  }

  proc.kill('SIGTERM');
}

function spawnCommand(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }

  return spawn(command, args, {
    cwd: opts.cwd ?? root,
    env,
    stdio: 'inherit',
  });
}

function runCommand(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<void>((resolve, reject) => {
    const child = spawnCommand(command, args, opts);

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
      }
    });
    child.on('error', reject);
  });
}

async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(2_000),
      });

      if (res.status < 500) {
        return;
      }
    } catch {
      // server not ready yet
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function runFixture(fixture: FixtureConfig, mockMi: MockMiServer): Promise<void> {
  let server: ChildProcess | undefined;
  const configPath = path.join(fixture.dir, fixture.configFile);
  const baseURL = `http://localhost:${fixture.port}`;
  const originalConfig = fs.readFileSync(configPath, 'utf-8');

  try {
    const patchedConfig = originalConfig.replace(
      /url:\s*['"]https?:\/\/[^'"]+['"]/,
      `url: '${mockMi.url}'`,
    );

    if (patchedConfig === originalConfig) {
      throw new Error(`Could not patch ${fixture.testType} pp-dev config to use mock-mi`);
    }

    fs.writeFileSync(configPath, patchedConfig);

    server = spawnCommand(
      process.execPath,
      [ppDevBinFor(fixture.dir), ...fixture.commandArgs, '--host', 'localhost', '--port', String(fixture.port), '--strictPort'],
      {
        cwd: fixture.dir,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: undefined },
      },
    );

    await waitForServer(baseURL);

    await runCommand(process.execPath, [playwrightCli, 'test', ...defaultPlaywrightArgs, ...playwrightArgs], {
      cwd: root,
      env: {
        ...process.env,
        BASE_URL: baseURL,
        TEST_TYPE: fixture.testType,
        FORCE_COLOR: undefined,
      },
    });
  } finally {
    if (server) {
      killTree(server);
    }
    fs.writeFileSync(configPath, originalConfig);
  }
}

async function main() {
  let mockMi: MockMiServer | undefined;
  let completed = false;

  try {
    mockMi = await startMockMiServer({
      mode: mockMode,
      cassetteName,
      realMiUrl,
    });

    for (const fixtureName of fixtureNames) {
      const fixture = fixtureConfigs[fixtureName];

      console.log(`\n[browser-e2e] Running ${fixture.testType} at http://localhost:${fixture.port}\n`);
      await runFixture(fixture, mockMi);
    }

    completed = true;
  } finally {
    if (completed) {
      mockMi?.save?.();
    }
    await mockMi?.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
