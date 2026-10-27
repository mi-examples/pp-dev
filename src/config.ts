import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
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

/**
 * Bundling puts every file a config imports into one module, which would make `__dirname`,
 * `__filename` and `import.meta.url` / `.dirname` / `.filename` point at the bundle for all of them.
 * Each file gets its own values instead (the way Vite loads its config): constants prepended to
 * the file, on its first line so source-map lines stay, and `define` points the names at them.
 */
const MODULE_LOCATION = {
  dirname: '__pp_dev_injected_dirname',
  filename: '__pp_dev_injected_filename',
  url: '__pp_dev_injected_import_meta_url',
} as const;

const MODULE_LOCATION_DEFINE: Record<string, string> = {
  __dirname: MODULE_LOCATION.dirname,
  __filename: MODULE_LOCATION.filename,
  'import.meta.url': MODULE_LOCATION.url,
  'import.meta.dirname': MODULE_LOCATION.dirname,
  'import.meta.filename': MODULE_LOCATION.filename,
};

const moduleLocationPlugin: import('esbuild').Plugin = {
  name: 'pp-dev:config-module-location',
  setup(build) {
    build.onLoad({ filter: /\.[cm]?[jt]s$/ }, (args) => {
      const contents = readFileSync(args.path, 'utf-8');
      const injected =
        `const ${MODULE_LOCATION.dirname} = ${JSON.stringify(path.dirname(args.path))};` +
        `const ${MODULE_LOCATION.filename} = ${JSON.stringify(args.path)};` +
        `const ${MODULE_LOCATION.url} = ${JSON.stringify(pathToFileURL(args.path).href)};`;

      return { contents: injected + contents, loader: /ts$/.test(args.path) ? 'ts' : 'js' };
    });
  },
};

/**
 * Loads a JS or TS config file: bundles it (local imports included, packages left external) into a
 * temporary module with a unique name, and imports that.
 *
 * A config can't be imported from its own path: Node caches a module for the life of the process
 * (the ESM loader by URL, `require.cache` for CommonJS by file name, also when imported), so after
 * an edit the watcher restarted the server with the old config. A cache-busting `?t=` query would
 * miss CommonJS configs and the files a config imports.
 */
async function loadBundledConfig<T extends object>(filePath: string, projectRoot: string) {
  // Performance optimization: Check cache first
  const cacheKey = `bundled:${filePath}`;
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
    plugins: [moduleLocationPlugin],
    define: MODULE_LOCATION_DEFINE,
    // An ESM bundle has no `require`, which the CommonJS files a config imports call for packages
    // and Node built-ins (esbuild leaves those requires in place). A config's own top-level
    // `require` doesn't clash: esbuild renames it.
    ...(isESM
      ? {
          banner: {
            js: "import { createRequire as __ppDevCreateRequire } from 'node:module';const require = __ppDevCreateRequire(import.meta.url);",
          },
        }
      : {}),
  });

  const { text: code } = result.outputFiles[0];

  // A unique name makes Node evaluate the module afresh. The temporary file sits next to the
  // config, so packages resolve from the project as before. Its extension says the format esbuild
  // wrote: a `.js` one would be read by the project's package.json `type`, which breaks a `.cts`
  // config in an ESM project and an `.mts` one in a CommonJS project.
  const fileBase = `pp-config.timestamp-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const fileNameTmp = `${fileBase}.${isESM ? 'mjs' : 'cjs'}`;
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
    try {
      unlinkSync(tempFilePath);
    } catch {
      // Ignore errors
    }
  }

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

      if (/\.[cm]?[jt]s$/i.test(configName)) {
        return (await loadBundledConfig(configPath, projectRoot)) as T;
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
