import { InlineConfig, PluginOption } from 'vite';
import type { NormalizedVitePPDevOptions } from './plugin.js';
import { normalizeVitePPDevConfig } from './plugin.js';
import { clientInjectionPlugin, miTopBarPlugin } from './plugins/index.js';
import header from './banner/header.js';
import type { NextConfig } from 'next';
import { safeNextImport } from './lib/next-import.js';
import { getConfig, getPkg, PPDevConfig } from './config.js';

export type { PPDevConfig, PPWatchConfig } from './config.js';

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

const pathPagePrefix = '/p';
const pathTemplatePrefix = '/pt';
const pathTemplateLocalPrefix = '/pl';

export async function getViteConfig() {
  const pkg = getPkg();

  const templateName = pkg.name;

  const ppDevConfig = await getConfig();
  const normalizedPPDevConfig = normalizeVitePPDevConfig(
    Object.assign(ppDevConfig, { templateName }),
  );

  // Lazy import vitePPDev to avoid loading plugin module during Next.js config evaluation
  const { default: vitePPDev } = await import('./plugin.js');

  const plugins: InlineConfig['plugins'] = [
    vitePPDev(normalizedPPDevConfig),
    clientInjectionPlugin(),
  ];

  const { outDir, distZip, imageOptimizer, templateLess, integrateMiTopBar } =
    normalizedPPDevConfig;

  if (integrateMiTopBar) {
    plugins.push(miTopBarPlugin(integrateMiTopBar));
  }

  if (imageOptimizer) {
    const { ViteImageOptimizer } = await import('vite-plugin-image-optimizer');

    plugins.push(
      ViteImageOptimizer(
        typeof imageOptimizer === 'object' ? imageOptimizer : undefined,
      ),
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
    base: templateLess
      ? `${pathPagePrefix}/${templateName}`
      : `${pathTemplatePrefix}/${templateName}`,
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
      scss: {
        api: 'modern',
      },
    },
    ppDevConfig: normalizedPPDevConfig,
    plugins,
  } as InlineConfig;
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
 * module.exports = withPPDev({ ... }, { backendBaseURL: '...' });
 *
 * // Or use standalone pp-dev.config.js (preferred - no Next.js config pollution)
 * module.exports = { ... };  // your next config
 * ```
 */
export function getPPDevConfigFromNextConfig(nextConfig: any): PPDevConfig {
  return nextConfig?.ppDev || {};
}

// Export the safe import utility for consumers who need it
export {
  safeNextImport,
  isNextAvailable,
  getNextVersion,
} from './lib/next-import.js';

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
        return `${pathPagePrefix}/${templateName}`;
      } else {
        return `${pathTemplateLocalPrefix}/${templateName}`;
      }
    } else {
      if (templateLess) {
        return `${pathPagePrefix}/${templateName}`;
      } else {
        return `${pathTemplatePrefix}/${templateName}`;
      }
    }
  }

  return `/p/${templateName}`;
}

/**
 * Merges multiple configuration objects with proper typing and order
 * @param baseConfig - Base configuration to start with
 * @param nextConfiguration - Next.js configuration to merge
 * @param additionalConfig - Additional configuration to merge last
 * @returns Merged configuration object
 */
function mergeConfigs(
  baseConfig: NextConfig,
  nextConfiguration: NextConfig,
  additionalConfig?: Partial<NextConfig>,
): NextConfig {
  return Object.assign({}, baseConfig, nextConfiguration, additionalConfig);
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
    | ((
        phase: string,
        nextConfig?: { defaultConfig?: any },
      ) => NextConfig | Promise<NextConfig>),
  ppDevConfig?: PPDevConfig,
) {
  return async (
    phase: string,
    nextConfig: { defaultConfig?: any } = {},
  ): Promise<NextConfig> => {
    try {
      const { constants } = await safeNextImport();
      const { PHASE_DEVELOPMENT_SERVER } = constants;

      const config = await getConfig();
      const pkg = getPkg();
      const templateName = pkg.name;

      // Resolve the Next.js configuration
      const nextConfiguration =
        typeof nextjsConfig === 'function'
          ? await nextjsConfig(phase, nextConfig)
          : nextjsConfig;

      // Get pp-dev config from Next.js config if available
      // Priority order: file config -> Next.js config -> function parameter config
      const nextConfigPPDev = getPPDevConfigFromNextConfig(nextConfiguration);
      const mergedConfig = Object.assign(
        {},
        config,
        nextConfigPPDev,
        ppDevConfig ?? {},
      );

      // Create base configuration with appropriate base path
      const isDevelopment = phase === PHASE_DEVELOPMENT_SERVER;
      const basePath = createBasePath(
        templateName,
        mergedConfig.templateLess ?? false,
        isDevelopment,
        mergedConfig.v7Features ?? false,
      );

      const baseConfig: NextConfig = {
        basePath,
        trailingSlash: isDevelopment ? true : undefined,
      };

      if (!mergedConfig.templateLess) {
        baseConfig.assetPrefix = `${pathTemplatePrefix}/${templateName}`;
      }

      if (isDevelopment) {
        // Merge base config with user's Next.js config.
        // PP-Dev config is NOT added to Next.js config (avoids "Unrecognized key" warnings).
        // CLI and app get config from getConfig() / pp-dev.config.js instead.
        return mergeConfigs(baseConfig, nextConfiguration);
      }

      // Production configuration
      return mergeConfigs(baseConfig, nextConfiguration);
    } catch (error) {
      console.error('Error in withPPDev:', error);
      console.warn('Falling back to original Next.js configuration');

      // Fallback to original config if something goes wrong
      try {
        const fallbackConfig =
          typeof nextjsConfig === 'function'
            ? await nextjsConfig(phase, nextConfig)
            : nextjsConfig;
        return fallbackConfig;
      } catch (fallbackError) {
        console.error('Error in fallback configuration:', fallbackError);
        // Last resort: return empty config
        return {};
      }
    }
  };
}
