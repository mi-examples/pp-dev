/**
 * E2E: a template sync under `pp-dev next` builds the app next to the running dev server.
 *
 * Its `next build` exported into the app's `distDir` (`dist`), which the export empties first, so
 * the dev server lost its `dist/dev` (manifests, Turbopack cache) on every sync; and it type-checked
 * the dev server's route types next to its own ("Duplicate identifier 'PagesPageConfig'") after any
 * dev session. The sync's build now goes to `.next` and exports to `out` (see
 * `DistService.buildNextAssets`), with the dev server's route types removed first.
 *
 * Against mock-mi replay: the cassette leaves the template's assets out on purpose, so this suite
 * serves a small zip for them and accepts the upload.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';
import { WebSocket } from 'ws';
import { startMockMiServer, type MockMiServer } from '../mock-mi/server.js';
import { PP_DEV_HMR_WS_PATH } from '../../src/shared/ws-messages.js';
import { pointConfigAt, startDevServer, type DevServerProcess } from './helpers/pp-dev-process.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_APP_DIR = path.resolve(__dirname, '../test-nextjs');
const CONFIG_PATH = path.join(TEST_APP_DIR, 'pp-dev.config.ts');
const PORT = 3109;
const PAGE_URL = `http://localhost:${PORT}/pl/pp-dev-test-template/`;
/** The template of the page the cassette describes (app.id 937). */
const TEMPLATE_ASSETS_PATH = '/api/page_template/id/313/asset';

async function templateAssetsZip(): Promise<string> {
  const zip = new JSZip();

  zip.file('index.html', '<html><body>the template as it is on MI</body></html>');

  return (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64');
}

/** Runs a template sync over the dev panel's WebSocket; the server's `template:sync:response`. */
function syncTemplate(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}${PP_DEV_HMR_WS_PATH}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('No template:sync:response within 4 minutes'));
    }, 240_000);

    ws.on('open', () => ws.send(JSON.stringify({ type: 'custom', event: 'template:sync', data: {} })));
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { event?: string; data?: Record<string, unknown> };

      if (message.event === 'template:sync:response') {
        clearTimeout(timer);
        ws.close();
        resolve(message.data ?? {});
      }
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe('pp-dev next: a template sync next to the running dev server', { timeout: 300_000 }, () => {
  let mockMi: MockMiServer;
  let ppdev: DevServerProcess;
  let config: { restore(): void } | undefined;
  const backupsDir = path.join(TEST_APP_DIR, 'backups');
  const hadBackups = fs.existsSync(backupsDir);

  beforeAll(async () => {
    mockMi = await startMockMiServer({
      mode: 'replay',
      cassetteName: 'startup',
      interactions: [
        {
          request: { method: 'GET', pathname: `${TEMPLATE_ASSETS_PATH}/download` },
          response: {
            status: 200,
            headers: { 'content-type': 'application/zip' },
            body: await templateAssetsZip(),
            bodyEncoding: 'base64',
          },
        },
        {
          request: { method: 'POST', pathname: `${TEMPLATE_ASSETS_PATH}/upload` },
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'OK' }),
          },
        },
      ],
    });
    config = pointConfigAt(CONFIG_PATH, mockMi.url);
    // Through npm as the lifecycle suite does: process.execPath under nvm4w is a shim.
    ppdev = startDevServer('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
      cwd: TEST_APP_DIR,
      shell: true,
      echo: true,
    });
    await ppdev.waitForLine(/Config file watcher started/i, 90_000);
  }, 120_000);

  afterAll(async () => {
    ppdev?.kill();
    config?.restore();
    await mockMi?.close();

    // What the sync left in the fixture: its backup and sync meta. The export stays, ignored by git.
    if (!hadBackups) {
      fs.rmSync(backupsDir, { recursive: true, force: true });
    }
  });

  it('builds apart from the dev server, which keeps serving the page', async () => {
    // The page once, so the dev server has written its files under dist/dev.
    const before = await fetch(PAGE_URL, { signal: AbortSignal.timeout(60_000) });

    expect(before.status).toBe(200);

    const devDir = path.join(TEST_APP_DIR, 'dist', 'dev');
    const hadDevTypes = fs.existsSync(path.join(devDir, 'types'));

    expect(fs.existsSync(devDir)).toBe(true);
    // Handed the loaded config, whose distDir is already `dist/dev`, Next appended `/dev` once more:
    // the server wrote under `dist/dev/dev`, and listed that in the app's tsconfig on every start.
    expect(fs.existsSync(path.join(devDir, 'dev'))).toBe(false);
    expect(fs.readFileSync(path.join(TEST_APP_DIR, 'tsconfig.json'), 'utf8')).not.toContain('dist/dev/dev/');

    const response = await syncTemplate();

    expect(response, ppdev.lines.join('\n')).toMatchObject({ syncedAt: expect.any(String) });
    expect(ppdev.lines.some((line) => /Next\.js build finished/.test(line))).toBe(true);
    expect(ppdev.lines.some((line) => /Removed stale dev route types/.test(line))).toBe(hadDevTypes);

    // Its export, apart from the dev server's directory, which is still there.
    expect(fs.existsSync(path.join(TEST_APP_DIR, 'out', 'index.html'))).toBe(true);
    expect(fs.existsSync(devDir)).toBe(true);

    // And the dev server still serves the page.
    const after = await fetch(PAGE_URL, { signal: AbortSignal.timeout(60_000) });

    expect(after.status).toBe(200);
    expect(await after.text()).toContain('</html>');
  });
});
