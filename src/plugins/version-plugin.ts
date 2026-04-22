import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Plugin } from 'vite';
import type { VersionPluginOptions } from '../plugin.js';

interface VersionPluginConfig extends VersionPluginOptions {
  outDir: string;
  packageVersion: string;
  packageRepositoryUrl?: string;
  packageBranchName?: string;
}

interface VersionManifest {
  schemaVersion: number;
  version: string;
  date: string;
  checksum: string;
  files: Record<string, string>;
  repositoryUrl?: string;
  branchName?: string;
  helperVersion: string;
}

interface BuildManifest {
  schemaVersion: number;
  manifestType: 'pp-dev-build-manifest';
  generatedAt: string;
  versionFile: string;
  versionFileTemplate: string;
  versionFileSchemaVersion: number;
  buildFingerprint: string;
  compat: {
    versionFileRequired: true;
  };
}

const VERSION_FILE_SCHEMA_VERSION = 1;
const BUILD_MANIFEST_SCHEMA_VERSION = 1;
const BUILD_MANIFEST_FILE_NAME = 'BUILD-MANIFEST.json';
const DEFAULT_VERSION_FILE_TEMPLATE = 'VERSION-v{packageversion}-{currentDate}.json';

function walkDir(dir: string, baseDir: string, excludeFiles: ReadonlySet<string> = new Set()): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath, baseDir, excludeFiles));
    } else if (entry.isFile() && !excludeFiles.has(relativePath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function sha256OfContent(filePath: string): string {
  const content = readFileSync(filePath);

  return createHash('sha256').update(content).digest('hex');
}

function computeChecksum(files: Record<string, string>): string {
  const sortedPaths = Object.keys(files).sort();
  const hashesConcatenated = sortedPaths.map((p) => files[p]).join('');

  return createHash('sha256').update(hashesConcatenated).digest('hex');
}

function computeBuildFingerprint(files: Record<string, string>): string {
  const normalizedEntries = Object.keys(files)
    .sort()
    .map((entry) => `${entry}:${files[entry]}`)
    .join('\n');

  return createHash('sha256').update(normalizedEntries, 'utf-8').digest('hex');
}

function resolveVersionFileName(template: string, packageVersion: string, currentDate: string): string {
  return template.replace(/\{packageversion\}/g, packageVersion).replace(/\{currentDate\}/g, currentDate);
}

function stripUrlUserInfo(value: string): string {
  return value.replace(/^([a-z][a-z\d+.-]*:\/\/)(?:[^/?#@]+(?::[^/?#@]*)?@)/i, '$1');
}

function normalizeRepositoryUrl(url: string): string {
  const normalizedUrl = url
    .trim()
    .replace(/^git\+/, '')
    .replace(/\.git$/i, '');
  const scpLikeMatch = normalizedUrl.match(/^([^@]+)@([^:]+):(.+)$/);

  if (scpLikeMatch) {
    const [, , host, repositoryPath] = scpLikeMatch;

    return stripUrlUserInfo(`https://${host}/${repositoryPath.replace(/^\/+/, '')}`);
  }

  const sshProtocolMatch = normalizedUrl.match(/^ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);

  if (sshProtocolMatch) {
    const [, host, repositoryPath] = sshProtocolMatch;

    return stripUrlUserInfo(`https://${host}/${repositoryPath.replace(/^\/+/, '')}`);
  }

  const gitProtocolMatch = normalizedUrl.match(/^git:\/\/([^/]+)\/(.+)$/i);

  if (gitProtocolMatch) {
    const [, host, repositoryPath] = gitProtocolMatch;

    return stripUrlUserInfo(`https://${host}/${repositoryPath.replace(/^\/+/, '')}`);
  }

  return stripUrlUserInfo(normalizedUrl);
}

function resolveHelperVersion(): string {
  const modulePath = fileURLToPath(import.meta.url);
  let currentDir = path.dirname(modulePath);

  while (true) {
    const packageJsonPath = path.join(currentDir, 'package.json');
    const packageStat = statSync(packageJsonPath, { throwIfNoEntry: false });

    if (packageStat?.isFile()) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: unknown };

        if (typeof packageJson.version === 'string') {
          return packageJson.version;
        }
      } catch {
        // Continue searching parent directories.
      }
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return 'unknown';
    }

    currentDir = parentDir;
  }
}

function resolveBranchName(configBranchName?: string): string | undefined {
  if (typeof configBranchName === 'string' && configBranchName.trim()) {
    return configBranchName.trim();
  }

  const ciBranchEnvVars = [
    'GITHUB_HEAD_REF',
    'GITHUB_REF_NAME',
    'CI_COMMIT_REF_NAME',
    'BITBUCKET_BRANCH',
    'BUILD_SOURCEBRANCHNAME',
    'BRANCH_NAME',
    'TRAVIS_BRANCH',
    'CIRCLE_BRANCH',
    'BUILDKITE_BRANCH',
    'VERCEL_GIT_COMMIT_REF',
  ] as const;

  for (const variableName of ciBranchEnvVars) {
    const branchName = process.env[variableName];

    if (typeof branchName === 'string' && branchName.trim()) {
      return branchName.trim();
    }
  }

  try {
    const currentBranchName = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (currentBranchName && currentBranchName !== 'HEAD') {
      return currentBranchName;
    }
  } catch {
    // Ignore git failures (not a git repo, git missing, or detached state).
  }

  return undefined;
}

export function versionPlugin(config: VersionPluginConfig): Plugin {
  return {
    name: 'pp-dev-version',
    apply: 'build',
    enforce: 'post',

    closeBundle() {
      if (config.enabled === false) {
        return;
      }

      const { outDir, versionFileTemplate, packageVersion } = config;
      const outDirResolved = path.resolve(process.cwd(), outDir);

      if (!statSync(outDirResolved, { throwIfNoEntry: false })?.isDirectory()) {
        return;
      }

      const now = new Date();
      const manifestDate = now.toISOString();
      const currentDate = manifestDate.replace(/:/g, '-');
      const resolvedVersionFileTemplate = versionFileTemplate ?? DEFAULT_VERSION_FILE_TEMPLATE;
      const versionFileName = resolveVersionFileName(resolvedVersionFileTemplate, packageVersion, currentDate);

      const allPaths = walkDir(outDirResolved, outDirResolved, new Set([versionFileName, BUILD_MANIFEST_FILE_NAME]));
      const files: Record<string, string> = {};

      for (const filePath of allPaths) {
        const relativePath = path.relative(outDirResolved, filePath).replace(/\\/g, '/');

        files[relativePath] = sha256OfContent(filePath);
      }

      const checksum = computeChecksum(files);
      const buildFingerprint = computeBuildFingerprint(files);
      const helperVersion = resolveHelperVersion();
      const branchName = resolveBranchName(config.packageBranchName);

      const manifest: VersionManifest = {
        schemaVersion: VERSION_FILE_SCHEMA_VERSION,
        version: `v${packageVersion}`,
        date: manifestDate,
        checksum,
        files,
        repositoryUrl: config.packageRepositoryUrl ? normalizeRepositoryUrl(config.packageRepositoryUrl) : undefined,
        branchName,
        helperVersion,
      };

      const manifestPath = path.join(outDirResolved, versionFileName);
      const buildManifestPath = path.join(outDirResolved, BUILD_MANIFEST_FILE_NAME);
      const buildManifest: BuildManifest = {
        schemaVersion: BUILD_MANIFEST_SCHEMA_VERSION,
        manifestType: 'pp-dev-build-manifest',
        generatedAt: manifestDate,
        versionFile: versionFileName,
        versionFileTemplate: resolvedVersionFileTemplate,
        versionFileSchemaVersion: VERSION_FILE_SCHEMA_VERSION,
        buildFingerprint,
        compat: {
          versionFileRequired: true,
        },
      };

      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
      writeFileSync(buildManifestPath, JSON.stringify(buildManifest, null, 2), 'utf-8');
    },
  };
}
