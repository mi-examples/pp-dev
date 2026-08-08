import { readdirSync, readFileSync, unlink, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { PP_DEV_CONFIG_NAMES } from './constants.js';
import { pathToFileURL } from 'url';
import type { PPDevConfig } from './plugin.js';

export type { PPDevConfig } from './plugin.js';

// Performance optimization: Cache for configuration files
interface ConfigCache {
  data: any;
  timestamp: number;
  filePath: string;
}

const configCache = new Map<string, ConfigCache>();
const CACHE_TTL = 30 * 1000; // 30 seconds cache

// Performance optimization: Memoized package.json reading
const packageJsonCache = new Map<string, { data: any; timestamp: number }>();
const PACKAGE_CACHE_TTL = 60 * 1000; // 1 minute cache

function getPackageJson(projectRoot = process.cwd()): any {
  const now = Date.now();
  const root = path.resolve(projectRoot);
  const cached = packageJsonCache.get(root);

  if (cached && now - cached.timestamp < PACKAGE_CACHE_TTL) {
    return cached.data;
  }

  try {
    const data = JSON.parse(
      readFileSync(path.resolve(root, 'package.json'), {
        encoding: 'utf-8',
        flag: 'r',
      }),
    );

    packageJsonCache.set(root, { data, timestamp: now });

    return data;
  } catch {
    const empty = {};

    packageJsonCache.set(root, { data: empty, timestamp: now });

    return empty;
  }
}

// Performance optimization: Lazy esbuild import
let esbuildModule: typeof import('esbuild') | null = null;

async function getEsbuild() {
  if (!esbuildModule) {
    esbuildModule = await import('esbuild');
  }

  return esbuildModule;
}

async function loadTsConfig<T extends object>(filePath: string, projectRoot: string) {
  // Performance optimization: Check cache first
  const cacheKey = `ts:${filePath}`;
  const cached = configCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data as T;
  }

  let isESM = false;

  if (/\.m[jt]s$/.test(filePath)) {
    isESM = true;
  } else if (/\.c[jt]s$/.test(filePath)) {
    isESM = false;
  } else {
    // Performance optimization: Use cached package.json
    const pkg = getPackageJson(projectRoot);

    isESM = !!pkg && pkg.type === 'module';
  }

  const esbuild = await getEsbuild();

  const result = await esbuild.build({
    absWorkingDir: projectRoot,
    entryPoints: [filePath],
    outfile: 'out.js',
    write: false,
    target: 'node24',
    platform: 'node',
    bundle: true,
    packages: 'external',
    format: isESM ? 'esm' : 'cjs',
    mainFields: ['main'],
    sourcemap: 'inline',
    metafile: true,
  });

  const { text: code } = result.outputFiles[0];

  const fileBase = `pp-config.timestamp-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const fileNameTmp = `${fileBase}.js`;
  const tempFilePath = path.resolve(projectRoot, fileNameTmp);
  const fileUrl = pathToFileURL(tempFilePath).toString();

  writeFileSync(tempFilePath, code);

  let config: T = {} as T;

  try {
    const conf = (await import(fileUrl)).default;

    config = conf?.default || conf;

    // Cache the result
    configCache.set(cacheKey, {
      data: config,
      timestamp: Date.now(),
      filePath,
    });
  } finally {
    // Clean up temp file
    if (existsSync(tempFilePath)) {
      unlink(tempFilePath, () => {
        // Ignore errors
      });
    }
  }

  return config;
}

async function loadJsConfig<T extends object>(filePath: string) {
  // Performance optimization: Check cache first
  const cacheKey = `js:${filePath}`;
  const cached = configCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data as T;
  }

  const config = (await import(pathToFileURL(filePath).toString())).default as T;

  // Cache the result
  configCache.set(cacheKey, {
    data: config,
    timestamp: Date.now(),
    filePath,
  });

  return config;
}

async function loadJSONConfig<T extends object>(filePath: string) {
  // Performance optimization: Check cache first
  const cacheKey = `json:${filePath}`;
  const cached = configCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data as T;
  }

  const config = JSON.parse(readFileSync(filePath, { encoding: 'utf-8' })) as T;

  // Cache the result
  configCache.set(cacheKey, {
    data: config,
    timestamp: Date.now(),
    filePath,
  });

  return config;
}

// Performance optimization: Memoized directory reading
const dirContentCache = new Map<string, { files: string[]; timestamp: number }>();
const DIR_CACHE_TTL = 10 * 1000; // 10 seconds cache

function getDirectoryContent(projectRoot: string): string[] {
  const now = Date.now();
  const cached = dirContentCache.get(projectRoot);

  if (cached && now - cached.timestamp < DIR_CACHE_TTL) {
    return cached.files;
  }

  const endsWithRegExp = /\.config\.(([cm]?ts)|([cm]?js)|(json))$/;
  const files = readdirSync(projectRoot, { withFileTypes: true })
    .filter((value) => value.isFile() && endsWithRegExp.test(value.name))
    .map((value) => value.name);

  dirContentCache.set(projectRoot, { files, timestamp: now });

  return files;
}

async function loadConfig<T extends object>(dirFiles: string[], configNames: string[], projectRoot: string) {
  for (const configName of configNames) {
    if (dirFiles.includes(configName)) {
      const configPath = path.resolve(projectRoot, configName);

      if (/\.[cm]?ts$/i.test(configName)) {
        return (await loadTsConfig(configPath, projectRoot)) as T;
      } else if (/\.[cm]?js$/i.test(configName)) {
        return (await loadJsConfig(configPath)) as T;
      } else if (configName.endsWith('.json')) {
        return (await loadJSONConfig(configPath)) as T;
      }
    }
  }

  return null;
}

export function getPkg(projectRoot = process.cwd()) {
  return getPackageJson(projectRoot);
}

export async function getConfig(projectRoot = process.cwd()): Promise<PPDevConfig> {
  const root = path.resolve(projectRoot);
  const dirContent = getDirectoryContent(root);

  let config: PPDevConfig = {};
  let configFound = false;

  const newConfig = await loadConfig<PPDevConfig>(dirContent, PP_DEV_CONFIG_NAMES as never as string[], root);

  if (newConfig) {
    config = newConfig;
    configFound = true;
  }

  const pkg = getPackageJson(root);

  const packageConfig = pkg['pp-dev'];

  if (!configFound && packageConfig && typeof packageConfig === 'object' && !Array.isArray(packageConfig)) {
    config = packageConfig as PPDevConfig;
  }

  return config;
}

export function clearConfigCache() {
  configCache.clear();
  packageJsonCache.clear();
  dirContentCache.clear();
}
