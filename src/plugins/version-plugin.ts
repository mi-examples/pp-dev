import type { Plugin } from 'vite';
import type { VersionPluginOptions } from '../plugin.js';
import { writeBuildVersionManifest } from '../lib/version-manifest.js';

interface VersionPluginConfig extends VersionPluginOptions {
  outDir: string;
  packageVersion: string;
  packageRepositoryUrl?: string;
  packageBranchName?: string;
}

export function versionPlugin(config: VersionPluginConfig): Plugin {
  let outDir = config.outDir;
  let root = process.cwd();

  return {
    name: 'pp-dev-version',
    apply: 'build',
    enforce: 'post',

    configResolved(resolvedConfig) {
      outDir = resolvedConfig.build.outDir;
      root = resolvedConfig.root ?? root;
    },

    // Sequential: `closeBundle` hooks otherwise run in parallel, and the dist ZIP (a later plugin)
    // must not be packed before the VERSION and BUILD-MANIFEST files are written.
    closeBundle: {
      sequential: true,
      async handler() {
        await writeBuildVersionManifest({
          outDir,
          root,
          packageVersion: config.packageVersion,
          versionFileTemplate: config.versionFileTemplate,
          packageRepositoryUrl: config.packageRepositoryUrl,
          packageBranchName: config.packageBranchName,
          enabled: config.enabled,
        });
      },
    },
  };
}
