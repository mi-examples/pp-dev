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

/**
 * Constructs a Vite InlineConfig configured for the current project using its package name and PP-Dev settings.
 *
 * The returned config includes:
 * - a base path derived from the package name and `templateLess` setting,
 * - a dev server listening on port 3000,
 * - build options (no minification, assets inline limit, rollup banner, and output directory),
 * - CSS options for modules and modern SCSS API,
 * - the normalized PP-Dev configuration under `ppDevConfig`,
 * - a plugins array that always includes the core PP-Dev plugin and client injection plugin and may include the MI top bar, image optimizer, and zip packaging plugins depending on configuration.
 *
 * @returns A Vite InlineConfig tailored to the project's PP-Dev configuration and package name.
 */
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
 * Extracts the PP-Dev configuration from a Next.js configuration object.
 *
 * @param nextConfig - The Next.js config object to read from
 * @returns The `ppDev` configuration object found on the top-level of `nextConfig`, or an empty object if none is present
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
 * Determine the base path for a template given the template name and environment/feature flags.
 *
 * @param templateName - Template identifier used in the returned path
 * @param templateLess - When true, prefer the page-style path (`/p/{templateName}`) instead of template paths
 * @param isDevelopment - When true, compute development-specific local paths
 * @param v7Features - When true, apply v7 feature rules for development path selection
 * @returns The computed base path (for example `/p/{templateName}`, `/pt/{templateName}`, or `/pl/{templateName}`)
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
 * Merge Next.js configuration objects so later inputs override earlier ones.
 *
 * @param baseConfig - Base configuration whose values have lowest precedence
 * @param nextConfiguration - Next.js configuration whose values override `baseConfig`
 * @param additionalConfig - Optional configuration whose values override both previous configs
 * @returns The combined NextConfig with precedence: `additionalConfig` > `nextConfiguration` > `baseConfig`
 */
function mergeConfigs(
  baseConfig: NextConfig,
  nextConfiguration: NextConfig,
  additionalConfig?: Partial<NextConfig>,
): NextConfig {
  return Object.assign({}, baseConfig, nextConfiguration, additionalConfig);
}

/**
 * Wraps a Next.js configuration (or config factory) to apply PP-Dev-specific basePath and assetPrefix.
 *
 * The returned function resolves the original Next.js configuration (calling it if it's a factory),
 * merges PP-Dev settings (from ppDevConfig, the project's pp-dev config file, or next.config.ppDev) to
 * determine template-related options, and returns a NextConfig with an appropriate `basePath` and,
 * when applicable, `assetPrefix`. In development the PP-Dev settings are not injected into the Next.js
 * config to avoid unrecognized-key warnings; the original Next.js config is returned with the computed
 * basePath merged.
 *
 * @param nextjsConfig - A Next.js config object or a function that receives (phase, nextConfig) and returns a NextConfig
 * @param ppDevConfig - Optional PP-Dev configuration that overrides values from the project's pp-dev config and next.config.ppDev
 * @returns A function that accepts (phase, nextConfig) and yields a NextConfig with PP-Dev basePath and assetPrefix applied where appropriate
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