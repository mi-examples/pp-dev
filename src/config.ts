import { readdirSync, readFileSync, unlink, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { PP_DEV_CONFIG_NAMES, PP_WATCH_CONFIG_NAMES } from './constants.js';
import { pathToFileURL } from 'url';
import { type VitePPDevOptions } from './plugin.js';

export type PPDevConfig = Omit<VitePPDevOptions, 'templateName'>;
export type PPWatchConfig = { baseURL: string; portalPageId: number };

// Performance optimization: Cache for configuration files
interface ConfigCache {
  data: any;
  timestamp: number;
  filePath: string;
}

const configCache = new Map<string, ConfigCache>();
const CACHE_TTL = 30 * 1000; // 30 seconds cache

// Performance optimization: Memoized package.json reading
let packageJsonCache: { data: any; timestamp: number } | null = null;
const PACKAGE_CACHE_TTL = 60 * 1000; // 1 minute cache

function getPackageJson(): any {
  const now = Date.now();
  
  if (packageJsonCache && (now - packageJsonCache.timestamp) < PACKAGE_CACHE_TTL) {
    return packageJsonCache.data;
  }

  const cwd = process.cwd();
  try {
    const data = JSON.parse(
      readFileSync(path.resolve(cwd, 'package.json'), {
        encoding: 'utf-8',
        flag: 'r',
      }),
    );
    
    packageJsonCache = { data, timestamp: now };
    return data;
  } catch {
    const empty = {};
    packageJsonCache = { data: empty, timestamp: now };
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

async function loadTsConfig<T extends object>(filePath: string) {
  const cwd = process.cwd();

  // Performance optimization: Check cache first
  const cacheKey = `ts:${filePath}`;
  const cached = configCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.data as T;
  }

  let isESM = false;
  if (/\.m[jt]s$/.test(filePath)) {
    isESM = true;
  } else if (/\.c[jt]s$/.test(filePath)) {
    isESM = false;
  } else {
    // Performance optimization: Use cached package.json
    const pkg = getPackageJson();
    isESM = !!pkg && pkg.type === 'module';
  }

  const esbuild = await getEsbuild();
  
  const result = await esbuild.build({
    absWorkingDir: cwd,
    entryPoints: [filePath],
    outfile: 'out.js',
    write: false,
    target: ['node14.18', 'node16'],
    platform: 'node',
    bundle: true,
    format: isESM ? 'esm' : 'cjs',
    mainFields: ['main'],
    sourcemap: 'inline',
    metafile: true,
  });

  const { text: code } = result.outputFiles[0];

  const fileBase = `pp-config.timestamp-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const fileNameTmp = `${fileBase}.js`;
  const fileUrl = pathToFileURL(path.resolve(cwd, fileNameTmp)).toString();

  writeFileSync(fileNameTmp, code);

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
    if (existsSync(fileNameTmp)) {
      unlink(fileNameTmp, () => {
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
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
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
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
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
let dirContentCache: { files: string[]; timestamp: number } | null = null;
const DIR_CACHE_TTL = 10 * 1000; // 10 seconds cache

function getDirectoryContent(): string[] {
  const now = Date.now();
  
  if (dirContentCache && (now - dirContentCache.timestamp) < DIR_CACHE_TTL) {
    return dirContentCache.files;
  }

  const endsWithRegExp = /\.config\.(([cm]?ts)|([cm]?js)|(json))$/;
  const cwd = process.cwd();
  const files = readdirSync(cwd, { withFileTypes: true })
    .filter((value) => value.isFile() && endsWithRegExp.test(value.name))
    .map((value) => value.name);

  dirContentCache = { files, timestamp: now };
  return files;
}

async function loadConfig<T extends object>(dirFiles: string[], configNames: string[]) {
  for (const configName of configNames) {
    if (dirFiles.includes(configName)) {
      if (/\.[cm]?ts$/i.test(configName)) {
        return (await loadTsConfig(configName)) as T;
      } else if (/\.[cm]?js$/i.test(configName)) {
        return (await loadJsConfig(path.resolve('.', configName))) as T;
      } else if (configName.endsWith('.json')) {
        return (await loadJSONConfig(path.resolve('.', configName))) as T;
      }
    }
  }

  return null;
}

export function getPkg() {
  return getPackageJson();
}

export async function getConfig() {
  const dirContent = getDirectoryContent();

  let config: PPDevConfig = {};
  let configFound = false;

  const newConfig = await loadConfig<PPDevConfig>(dirContent, PP_DEV_CONFIG_NAMES as never as string[]);

  if (newConfig) {
    config = newConfig;
    configFound = true;
  }

  if (dirContent.length) {
    if (!configFound) {
      const watchConfig = await loadConfig<PPWatchConfig>(dirContent, PP_WATCH_CONFIG_NAMES as never as string[]);

      if (watchConfig) {
        config = {
          backendBaseURL: watchConfig.baseURL,
          portalPageId: watchConfig.portalPageId,
        };

        configFound = true;
      }
    }
  }

  const pkg = getPackageJson();

  if (!configFound && typeof pkg['pp-dev'] === 'object') {
    config = pkg['pp-dev'];
  }

  return config;
}

// Export cache management functions for external use
export function clearConfigCache() {
  configCache.clear();
  packageJsonCache = null;
  dirContentCache = null;
}

export function getConfigCacheStats() {
  return {
    configEntries: configCache.size,
    packageJsonCached: !!packageJsonCache,
    dirContentCached: !!dirContentCache,
  };
}
