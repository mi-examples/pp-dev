/**
 * Runs `npm audit --json` in the repository root and every tests/* package that has a package.json.
 * Fails (exit 1) if any package reports a high/critical vulnerability that isn't in ALLOWLIST below.
 *
 * ALLOWLIST exists for advisories with no upstream fix that are mitigated outside of npm (e.g. an
 * application-level code change). Every entry must document why it's safe to allow, so this can't
 * silently swallow an unrelated future advisory against the same package. Remove an entry as soon as
 * a real fix ships upstream.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const ALLOWLIST = new Map([
  [
    'GHSA-jmr9-qjv8-65gv',
    'extract-zip unvalidated symlink path traversal — no patched release exists (2.0.1 is latest ' +
      'and still vulnerable). Mitigated via rejectSymlinks() in src/lib/helpers/zip.helper.ts, called ' +
      'after every extractZip() call and before the extracted tree is read from.',
  ],
]);

const FAILING_SEVERITIES = new Set(['high', 'critical']);

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
function runNpmAuditJson(cwd) {
  if (process.platform === 'win32') {
    return spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm audit --json'], { cwd, encoding: 'utf-8' });
  }

  return spawnSync('npm', ['audit', '--json'], { cwd, encoding: 'utf-8' });
}

/** Extract a GHSA id (as GitHub formats it, e.g. "GHSA-jmr9-qjv8-65gv") from an advisory URL. */
function ghsaIdFromUrl(url) {
  const match = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.exec(url ?? '');
  return match ? match[0] : null;
}

/** Resolve the set of root GHSA ids a vulnerability entry ultimately stems from. */
function resolveGhsaIds(vulnerabilities, name, seen) {
  if (seen.has(name)) {
    return [];
  }

  seen.add(name);

  const entry = vulnerabilities[name];

  if (!entry) {
    return [`UNKNOWN:${name}`];
  }

  const ids = [];

  for (const via of entry.via) {
    if (typeof via === 'string') {
      ids.push(...resolveGhsaIds(vulnerabilities, via, seen));
    } else {
      ids.push(ghsaIdFromUrl(via.url) ?? `UNKNOWN:${via.title ?? name}`);
    }
  }

  return ids;
}

function auditTarget(label, cwd) {
  const bar = '='.repeat(60);

  console.log(`\n${bar}\n  npm audit — ${label}\n${bar}\n`);

  const spawned = runNpmAuditJson(cwd);

  if (spawned.error || !spawned.stdout) {
    console.error(spawned.error ?? spawned.stderr ?? 'npm audit produced no output');
    return { label, ok: false };
  }

  let report;

  try {
    report = JSON.parse(spawned.stdout);
  } catch (err) {
    console.error('Failed to parse `npm audit --json` output:', err.message);
    console.error(spawned.stdout);
    return { label, ok: false };
  }

  const vulnerabilities = report.vulnerabilities ?? {};
  let unresolvedCount = 0;

  for (const [name, entry] of Object.entries(vulnerabilities)) {
    if (!FAILING_SEVERITIES.has(entry.severity)) {
      continue;
    }

    const ghsaIds = [...new Set(resolveGhsaIds(vulnerabilities, name, new Set()))];
    const unallowlisted = ghsaIds.filter((id) => !ALLOWLIST.has(id));

    if (unallowlisted.length === 0) {
      const reasons = ghsaIds.map((id) => `${id} — ${ALLOWLIST.get(id)}`).join('; ');

      console.log(`  ⚠ ${name} (${entry.severity}) — ALLOWLISTED: ${reasons}`);
      continue;
    }

    unresolvedCount += 1;
    console.log(`  ✗ ${name} (${entry.severity}) — ${unallowlisted.join(', ')}`);
  }

  if (unresolvedCount === 0) {
    console.log('  ✓ no unresolved high/critical vulnerabilities');
  }

  return { label, ok: unresolvedCount === 0 };
}

const results = targets.map(({ label, cwd }) => auditTarget(label, cwd));

console.log(`\n${'='.repeat(60)}\n  Audit summary\n${'='.repeat(60)}`);

let failed = false;

for (const { label, ok } of results) {
  if (!ok) {
    failed = true;
  }

  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${ok ? 'ok' : 'failed'}`);
}

console.log('');

if (failed) {
  process.exit(1);
}
