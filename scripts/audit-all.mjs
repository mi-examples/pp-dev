/**
 * Runs `npm audit --json` in the repository root and every tests/* package that has a package.json.
 * Fails (exit 1) if any package reports a high/critical vulnerability that isn't allowlisted.
 *
 * The allowlist is the shared one in mi-examples-workflows (audit-allowlist.json), read on every run: from
 * AUDIT_ALLOWLIST_URL, which the shared CI audit sets, else from its main branch. It holds advisories with no
 * upstream fix that can't be reached, each with a reason and an `until` date after which it stops applying.
 * Add or remove entries there, not here. If the list can't be loaded, nothing is allowlisted.
 * AUDIT_ALLOWLIST_URL=none audits without it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_ALLOWLIST_URL =
  'https://raw.githubusercontent.com/mi-examples/mi-examples-workflows/main/audit-allowlist.json';

/** Loads the shared allowlist: GHSA id -> reason, for the entries that haven't expired. */
async function loadAllowlist() {
  const source = process.env.AUDIT_ALLOWLIST_URL || DEFAULT_ALLOWLIST_URL;

  if (source === 'none') {
    return new Map();
  }

  try {
    let text;

    if (/^https?:\/\//.test(source)) {
      const response = await fetch(source, { signal: AbortSignal.timeout(15_000) });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      text = await response.text();
    } else {
      text = readFileSync(source, 'utf-8');
    }

    // An entry applies through its `until` day, in UTC.
    const today = new Date().toISOString().slice(0, 10);
    const allowlist = new Map();

    for (const entry of JSON.parse(text).entries ?? []) {
      const valid =
        /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(entry?.id ?? '') &&
        typeof entry.reason === 'string' &&
        entry.reason.trim() !== '' &&
        /^\d{4}-\d{2}-\d{2}$/.test(entry.until ?? '');

      if (!valid) {
        console.warn(`⚠ Ignoring an invalid audit allowlist entry: ${JSON.stringify(entry)}`);
      } else if (entry.until < today) {
        console.warn(`✗ The audit allowlist entry for ${entry.id} expired on ${entry.until}, so it applies no more.`);
      } else {
        allowlist.set(entry.id, `${entry.reason.trim()} (until ${entry.until})`);
      }
    }

    console.log(`Audit allowlist: ${source} (${allowlist.size} active)`);

    return allowlist;
  } catch (error) {
    console.warn(`⚠ Could not load the audit allowlist from ${source} (${error.message}); nothing is allowlisted.`);

    return new Map();
  }
}

const ALLOWLIST = await loadAllowlist();

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
