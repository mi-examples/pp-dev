import { InlineConfig, PluginOption } from 'vite';
import vitePPDev, { NormalizedVitePPDevOptions, normalizeVitePPDevConfig } from './plugin.js';
import { clientInjectionPlugin } from './plugins/client-injection-plugin.js';
import header from './banner/header.js';
import type { NextConfig } from 'next';
import { getConfig, getPkg, PPDevConfig } from './config.js';

export type { PPDevConfig, PPWatchConfig } from './config.js';

declare module 'vite' {
  interface UserConfig {
    ppDevConfig?: NormalizedVitePPDevOptions;
  }
}

export async function getViteConfig() {
  const pkg = getPkg();

  const templateName = pkg.name;

  const ppDevConfig = await getConfig();
  const normalizedPPDevConfig = normalizeVitePPDevConfig(Object.assign(ppDevConfig, { templateName }));

  const plugins: InlineConfig['plugins'] = [vitePPDev(normalizedPPDevConfig), clientInjectionPlugin()];

  const { outDir, distZip, imageOptimizer, templateLess } = normalizedPPDevConfig;

  if (imageOptimizer) {
    const { ViteImageOptimizer } = await import('vite-plugin-image-optimizer');

    plugins.push(ViteImageOptimizer(typeof imageOptimizer === 'object' ? imageOptimizer : undefined));
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
    base: templateLess ? `/p/${templateName}` : `/pt/${templateName}`,
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
      outDir,
    },
    ppDevConfig: normalizedPPDevConfig,
    plugins,
  } as InlineConfig;
}

export function withPPDev(
  nextjsConfig:
    | NextConfig
    | ((phase: string, nextConfig?: { defaultConfig?: any }) => NextConfig | Promise<NextConfig>),
  ppDevConfig?: PPDevConfig,
) {
  return async (phase: string, nextConfig: { defaultConfig?: any } = {}): Promise<NextConfig> => {
    const { PHASE_DEVELOPMENT_SERVER } = await import('next/constants.js');

    const config = await getConfig();
    const pkg = getPkg();
    const templateName = pkg.name;
    const nextConfiguration = typeof nextjsConfig === 'function' ? await nextjsConfig(phase, nextConfig) : nextjsConfig;

    if (phase === PHASE_DEVELOPMENT_SERVER) {
      const devConfig = Object.assign(config, ppDevConfig);

      const { templateLess } = devConfig;

      return Object.assign(
        { basePath: templateLess ? `/p/${templateName}` : `/pt/${templateName}`, trailingSlash: true } as NextConfig,
        nextConfiguration,
        {
          serverRuntimeConfig: {
            templateName,
            ppDevConfig: devConfig,
          },
          publicRuntimeConfig: {
            templateName,
            ppDevConfig: {
              backendBaseURL: devConfig.backendBaseURL,
              portalPageId: devConfig.portalPageId,
              templateLess: devConfig.templateLess,
            },
          },
        } as NextConfig,
      );
    }

    return Object.assign({ basePath: `/pt/${templateName}` } as NextConfig, nextConfiguration);
  };
}
