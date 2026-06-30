/**
 * Runs the DTS build (rollup-plugin-dts) in a child process with an OS-level
 * timeout + forced kill. On Windows, rollup-plugin-dts can leave TypeScript
 * language-service handles alive after the build completes, making the process
 * hang indefinitely. A plain setTimeout inside the rollup process won't help
 * when TS blocks the event loop synchronously. Running it as a child process
 * lets us kill the entire process tree from the outside.
 */
import { spawn, execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rollupBin = resolve(root, 'node_modules/rollup/dist/bin/rollup');
const TIMEOUT_MS = parseInt(process.env.PP_DEV_DTS_TIMEOUT_MS ?? '60000', 10);

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } catch {
      // already gone
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

console.log(`[build:types] Starting DTS build (timeout=${TIMEOUT_MS}ms)`);

const proc = spawn(
  process.execPath,
  [rollupBin, '--config', 'rollup.config.types.ts', '--configPlugin', 'typescript'],
  {
    cwd: root,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  },
);

const timer = setTimeout(() => {
  console.error(`[build:types] DTS build exceeded ${TIMEOUT_MS}ms — force-killing process tree`);
  killTree(proc.pid);
  process.exit(1);
}, TIMEOUT_MS);

proc.on('close', (code) => {
  clearTimeout(timer);
  if (code !== 0) {
    console.error(`[build:types] DTS build failed (exit ${code})`);
    process.exit(code ?? 1);
  }
  console.log('[build:types] DTS build completed successfully');
});
