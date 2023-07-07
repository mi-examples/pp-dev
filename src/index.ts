import { InlineConfig } from 'vite';
import { readFileSync, readdirSync, writeFileSync, unlink } from 'fs';
import * as path from 'path';
import vitePPDev, { VitePPDevOptions } from './plugin.js';
import zipPack from 'vite-plugin-zip-pack';
import { build } from 'esbuild';
import { pathToFileURL } from 'url';
import { PP_WATCH_CONFIG_NAMES, PP_DEV_CONFIG_NAMES } from './constants.js';
import { clientInjectionPlugin } from './plugins/client-injection-plugin.js';
import header from './banner/header.js';

export type PPDevConfig = Omit<VitePPDevOptions, 'templateName'>;
export type PPWatchConfig = { baseURL: string; portalPageId: number };

async function loadTsConfig<T extends object>(filePath: string) {
  const cwd = process.cwd();

  let isESM = false;
  if (/\.m[jt]s$/.test(filePath)) {
    isESM = true;
  } else if (/\.c[jt]s$/.test(filePath)) {
    isESM = false;
  } else {
    // check package.json for type: "module" and set `isESM` to true
    try {
      const cwd = process.cwd();
      const pkg = readFileSync(path.resolve(cwd, 'package.json'), {
        encoding: 'utf-8',
        flag: 'r',
      });

      isESM = !!pkg && JSON.parse(pkg).type === 'module';
    } catch (e) {
      //
    }
  }

  const result = await build({
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
  } finally {
    unlink(fileNameTmp, () => {
      //
    });
  }

  return config;
}

async function loadJsConfig<T extends object>(filePath: string) {
  return (await import(pathToFileURL(filePath).toString())).default as T;
}

async function loadJSONConfig<T extends object>(filePath: string) {
  return JSON.parse(readFileSync(filePath, { encoding: 'utf-8' })) as T;
}

async function loadConfig<T extends object>(dirFiles: string[], configNames: string[]) {
  for (const configName of configNames) {
    if (dirFiles.includes(configName)) {
      if (configName.endsWith('.ts')) {
        return (await loadTsConfig(configName)) as T;
      } else if (configName.endsWith('.js')) {
        return (await loadJsConfig(path.resolve('.', configName))) as T;
      } else if (configName.endsWith('.json')) {
        return (await loadJSONConfig(path.resolve('.', configName))) as T;
      }
    }
  }

  return null;
}

export async function getConfig() {
  const endsWithRegExp = /\.config\.((ts)|(js(on)?))$/;
  const cwd = process.cwd();
  const dirContent = readdirSync(cwd, { withFileTypes: true })
    .filter((value) => value.isFile() && endsWithRegExp.test(value.name))
    .map((value) => value.name);

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

  const pkg = JSON.parse(
    readFileSync(path.resolve(cwd, 'package.json'), {
      encoding: 'utf-8',
      flag: 'r',
    }),
  );

  if (!configFound && typeof pkg['pp-dev'] === 'object') {
    config = pkg['pp-dev'];
  }

  return config;
}

export async function getViteConfig() {
  const pkg = JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'package.json'), {
      encoding: 'utf-8',
      flag: 'r',
    }),
  );

  const templateName = pkg.name;

  return {
    base: `/pt/${templateName}`,
    server: {
      port: 3000,
    },
    build: {
      minify: false,
      rollupOptions: {
        output: {
          banner: header,
        },
      },
    },
    plugins: [
      vitePPDev({
        templateName,
        ...(await getConfig()),
      }),
      clientInjectionPlugin(),
      {
        ...zipPack({
          outFileName: `${templateName}.zip`,
        }),
        enforce: 'post',
      },
    ],
  } as InlineConfig;
}
