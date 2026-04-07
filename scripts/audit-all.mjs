/**
 * Runs `npm audit` in the repository root and every tests/* package that has a package.json.
 * Exits with code 1 if any audit reports vulnerabilities or fails.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {Array<{ label: string; cwd: string }>} */
const targets = [{ label: 'root', cwd: root }];

const testsDir = join(root, 'tests');

if (existsSync(testsDir)) {
  for (const entry of readdirSync(testsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const pkgPath = join(testsDir, entry.name, 'package.json');

    if (existsSync(pkgPath)) {
      targets.push({
        label: `tests/${entry.name}`,
        cwd: join(testsDir, entry.name),
      });
    }
  }
}

/**
 * Windows: `execFileSync("npm", …)` is unreliable (npm.cmd / EINVAL); use cmd.exe.
 * Unix: invoke `npm` directly (no shell) to avoid DEP0190.
 */
function runNpmAudit(cwd) {
  if (process.platform === 'win32') {
    return spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm audit'], {
      cwd,
      stdio: 'inherit',
    });
  }

  return spawnSync('npm', ['audit'], { cwd, stdio: 'inherit' });
}

const results = [];

for (const { label, cwd } of targets) {
  const bar = '='.repeat(60);

  console.log(`\n${bar}\n  npm audit — ${label}\n${bar}\n`);

  const spawned = runNpmAudit(cwd);
  const code = spawned.status ?? (spawned.error ? 1 : 0);

  results.push({ label, code });
}

console.log(`\n${'='.repeat(60)}\n  Audit summary\n${'='.repeat(60)}`);

let failed = false;

for (const { label, code } of results) {
  const ok = code === 0;

  if (!ok) {
    failed = true;
  }

  const status = ok ? 'ok' : `failed (exit ${code})`;

  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${status}`);
}

console.log('');

if (failed) {
  process.exit(1);
}
