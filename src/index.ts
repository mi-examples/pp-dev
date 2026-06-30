import { InlineConfig, PluginOption } from 'vite';
import { execSync } from 'child_process';
import type { NormalizedVitePPDevOptions } from './plugin.js';
import { normalizePPDevConfig, validatePPDevConfig } from './plugin.js';
import { clientInjectionPlugin, miTopBarPlugin } from './plugins/index.js';
import header from './banner/header.js';
import type { NextConfig } from 'next';
import { safeNextImport } from './lib/next-import.js';
import { getConfig, getPkg } from './config.js';
import type { PPDevConfig } from './plugin.js';
import { PATH_PAGE_PREFIX, PATH_TEMPLATE_PREFIX, PATH_TEMPLATE_LOCAL_PREFIX } from './constants.js';
import { createLogger } from './lib/logger.js';

export type { PPDevConfig } from './config.js';
export type {
  MiConfig,
  AppConfig,
  ProxyConfig,
  BuildConfig,
  SyncConfig,
  MiMode,
  MiInclude,
  AppType,
  VersionPluginOptions,
} from './plugin.js';
export { normalizePPDevConfig, validatePPDevConfig } from './plugin.js';
export { defineConfig } from './helpers.js';

declare module 'vite' {
  interface UserConfig {
    ppDevConfig?: NormalizedVitePPDevOptions;
  }
}

declare module 'next' {
  interface NextConfig {
    /** PP-Dev config. Prefer pp-dev.config.js to avoid Next.js validation warnings. */
    ppDev?: PPDevConfig;
  }
}

const PP_DEV_CONFIG_GROUPS = new Set(['mi', 'app', 'proxy', 'build', 'sync', 'inspector']);

function mergePPDevConfigs(...configs: Array<PPDevConfig | undefined>): PPDevConfig {
  const merged: PPDevConfig = {};
  const mutableMerged = merged as Record<string, unknown>;

  for (const config of configs) {
    if (!config) {
      continue;
    }

    for (const [key, value] of Object.entries(config)) {
      if (value === undefined) {
        continue;
      }

      if (PP_DEV_CONFIG_GROUPS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
        mutableMerged[key] = {
          ...((mutableMerged[key] as Record<string, unknown> | undefined) ?? {}),
          ...(value as Record<string, unknown>),
        };

        continue;
      }

      mutableMerged[key] = value;
    }
  }

  return merged;
}

function resolveRepositoryUrl(repository: unknown): string | undefined {
  if (typeof repository === 'string') {
    return repository;
  }

  if (
    repository &&
    typeof repository === 'object' &&
    'url' in repository &&
    typeof (repository as { url?: unknown }).url === 'string'
  ) {
    return (repository as { url: string }).url;
  }

  const directCiRepositoryUrlEnvVars = [
    'CI_REPOSITORY_URL',
    'GIT_URL',
    'BUILD_REPOSITORY_URI',
    'CI_PROJECT_URL',
    'BITBUCKET_GIT_HTTP_ORIGIN',
    'BUILDKITE_REPO',
  ] as const;

  for (const variableName of directCiRepositoryUrlEnvVars) {
    const ciRepositoryUrl = process.env[variableName];

    if (typeof ciRepositoryUrl === 'string' && ciRepositoryUrl.trim()) {
      return ciRepositoryUrl;
    }
  }

  const githubRepository = process.env.GITHUB_REPOSITORY;

  if (typeof githubRepository === 'string' && githubRepository.trim()) {
    const githubServerUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';

    return `${githubServerUrl.replace(/\/+$/, '')}/${githubRepository.replace(/^\/+/, '')}`;
  }

  const gitlabProjectPath = process.env.CI_PROJECT_PATH;

  if (typeof gitlabProjectPath === 'string' && gitlabProjectPath.trim()) {
    const gitlabServerUrl = process.env.CI_SERVER_URL || 'https://gitlab.com';

    return `${gitlabServerUrl.replace(/\/+$/, '')}/${gitlabProjectPath.replace(/^\/+/, '')}`;
  }

  const bitbucketRepositoryFullName = process.env.BITBUCKET_REPO_FULL_NAME;

  if (typeof bitbucketRepositoryFullName === 'string' && bitbucketRepositoryFullName.trim()) {
    return `https://bitbucket.org/${bitbucketRepositoryFullName.replace(/^\/+/, '')}`;
  }

  const travisRepositorySlug = process.env.TRAVIS_REPO_SLUG;

  if (typeof travisRepositorySlug === 'string' && travisRepositorySlug.trim()) {
    return `https://github.com/${travisRepositorySlug.replace(/^\/+/, '')}`;
  }

  try {
    const gitRemoteOriginUrl = execSync('git config --get remote.origin.url', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (gitRemoteOriginUrl) {
      return gitRemoteOriginUrl;
    }
  } catch {
    // Ignore git failures (not a git repo, git missing, or no origin remote).
  }

  return undefined;
}

export async function getViteConfig(): Promise<InlineConfig> {
  const pkg = getPkg();

  const templateName = pkg.name;

  const ppDevConfig = await getConfig();
  const normalizedPPDevConfig = normalizePPDevConfig(ppDevConfig, templateName);

  // Lazy import vitePPDev to avoid loading plugin module during Next.js config evaluation
  const { default: vitePPDev } = await import('./plugin.js');

  const plugins: InlineConfig['plugins'] = [vitePPDev(normalizedPPDevConfig), clientInjectionPlugin()];

  const { outDir, distZip, versionPlugin, imageOptimizer, templateLess, integrateMiTopBar } = normalizedPPDevConfig;

  if (integrateMiTopBar) {
    plugins.push(miTopBarPlugin(integrateMiTopBar));
  }

  if (imageOptimizer) {
    const { ViteImageOptimizer } = await import('vite-plugin-image-optimizer');

    plugins.push(ViteImageOptimizer(typeof imageOptimizer === 'object' ? imageOptimizer : undefined));
  }

  if (versionPlugin) {
    const { versionPlugin: versionPluginFn } = await import('./plugins/version-plugin.js');

    plugins.push(
      versionPluginFn({
        outDir,
        packageVersion: pkg.version ?? '0.0.0',
        packageRepositoryUrl: resolveRepositoryUrl(pkg.repository),
        ...(typeof versionPlugin === 'object' ? versionPlugin : {}),
      }),
    );
  }

  if (distZip) {
    const { default: zipPack } = await import('vite-plugin-zip-pack');

    plugins.push({
      ...zipPack(
        typeof distZip === 'object'
          ? distZip
          : {
              outFileName: `${templateName}.zip`,
            },
      ),
      enforce: 'post',
    } as PluginOption);
  }

  return {
    base: templateLess ? `${PATH_PAGE_PREFIX}/${templateName}` : `${PATH_TEMPLATE_PREFIX}/${templateName}`,
    server: {
      port: 3000,
    },
    build: {
      minify: false,
      assetsInlineLimit: 4096,
      rollupOptions: {
        output: {
          banner: header,
        },
      },
      outDir,
    },
    css: {
      modules: { localsConvention: 'dashes' },
    },
    ppDevConfig: normalizedPPDevConfig,
    plugins,
  };
}

/**
 * Gets pp-dev configuration from Next.js config.
 *
 * We no longer use experimental.ppDev (triggers Next.js "Unrecognized key" warning).
 * Config is read from: (1) top-level ppDev, (2) standalone pp-dev.config.js via getConfig().
 *
 * @param nextConfig - Next.js configuration object
 * @returns PP-Dev configuration or empty object if not found
 *
 * @example
 * ```ts
 * // In next.config.js - use withPPDev to avoid validation warnings
 * const { withPPDev } = require('@metricinsights/pp-dev');
 * module.exports = withPPDev({ ... }, { mi: { url: '...' } });
 *
 * // Or use standalone pp-dev.config.js (preferred - no Next.js config pollution)
 * module.exports = { ... };  // your next config
 * ```
 */
export function getPPDevConfigFromNextConfig(nextConfig: any): PPDevConfig {
  return nextConfig?.ppDev || {};
}

// Export the safe import utility for consumers who need it
export { safeNextImport, isNextAvailable, getNextVersion } from './lib/next-import.js';

// Export authentication provider for global state management
export { authProvider, AuthProvider } from './lib/auth.provider.js';
export type { AuthState } from './lib/auth.provider.js';

/**
 * Creates the appropriate base path for the template based on configuration and environment
 * @param templateName - Name of the template
 * @param templateLess - Whether the template is template-less
 * @param isDevelopment - Whether running in development mode
 * @returns The base path string
 */
function createBasePath(
  templateName: string,
  templateLess: boolean,
  isDevelopment: boolean,
  v7Features: boolean,
): string {
  if (isDevelopment) {
    if (v7Features) {
      if (templateLess) {
        return `${PATH_PAGE_PREFIX}/${templateName}`;
      } else {
        return `${PATH_TEMPLATE_LOCAL_PREFIX}/${templateName}`;
      }
    } else {
      if (templateLess) {
        return `${PATH_PAGE_PREFIX}/${templateName}`;
      } else {
        return `${PATH_TEMPLATE_PREFIX}/${templateName}`;
      }
    }
  }

  return `${PATH_PAGE_PREFIX}/${templateName}`;
}

/**
 * Higher-order function that wraps Next.js configuration with PP-Dev specific settings
 *
 * This function enhances Next.js configuration by:
 * - Adding appropriate base paths for different environments
 * - Injecting runtime configuration for PP-Dev
 * - Handling development vs production configurations
 * - Providing fallback behavior on errors
 *
 * @param nextjsConfig - Next.js configuration object or function
 * @param ppDevConfig - Optional PP-Dev specific configuration
 * @returns Function that returns enhanced Next.js configuration
 */
export function withPPDev(
  nextjsConfig:
    | NextConfig
    | ((phase: string, nextConfig?: { defaultConfig?: any }) => NextConfig | Promise<NextConfig>),
  ppDevConfig?: PPDevConfig,
) {
  return async (phase: string, nextConfig: { defaultConfig?: any } = {}): Promise<NextConfig> => {
    try {
      const { constants } = await safeNextImport();
      const { PHASE_DEVELOPMENT_SERVER } = constants;

      const config = await getConfig();
      const pkg = getPkg();
      const templateName = pkg.name;

      // Resolve the Next.js configuration
      const nextConfiguration =
        typeof nextjsConfig === 'function' ? await nextjsConfig(phase, nextConfig) : nextjsConfig;

      // Get pp-dev config from Next.js config if available
      // Priority order: file config -> Next.js config -> function parameter config
      const nextConfigPPDev = getPPDevConfigFromNextConfig(nextConfiguration);
      const mergedConfig = mergePPDevConfigs(config, nextConfigPPDev, ppDevConfig);
      const normalized = normalizePPDevConfig(mergedConfig, templateName);

      // Derive display flags from the same normalization path used by Vite/CLI.
      const { templateLess, v7Features } = normalized;

      // Create base configuration with appropriate base path
      const isDevelopment = phase === PHASE_DEVELOPMENT_SERVER;
      const basePath = createBasePath(normalized.templateName, templateLess, isDevelopment, v7Features);

      const baseConfig: NextConfig = {
        basePath,
        trailingSlash: isDevelopment ? true : undefined,
      };

      if (!templateLess) {
        baseConfig.assetPrefix = `${v7Features ? PATH_TEMPLATE_LOCAL_PREFIX : PATH_TEMPLATE_PREFIX}/${normalized.templateName}`;
      }

      // PP-Dev config is NOT added to Next.js config (avoids "Unrecognized key" warnings).
      // CLI and app get config from getConfig() / pp-dev.config.js instead.
      return Object.assign({}, baseConfig, nextConfiguration);
    } catch (error) {
      const logger = createLogger();

      logger.error('Error in withPPDev:', { error: error instanceof Error ? error : new Error(String(error)) });
      logger.warn('Falling back to original Next.js configuration');

      // Fallback to original config if something goes wrong
      try {
        const fallbackConfig =
          typeof nextjsConfig === 'function' ? await nextjsConfig(phase, nextConfig) : nextjsConfig;

        return fallbackConfig;
      } catch (fallbackError) {
        logger.error('Error in fallback configuration:', { error: fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError)) });

        // Last resort: return empty config
        return {};
      }
    }
  };
}
