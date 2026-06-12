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
  return {
    name: 'pp-dev-version',
    apply: 'build',
    enforce: 'post',

    closeBundle() {
      writeBuildVersionManifest({
        outDir: config.outDir,
        packageVersion: config.packageVersion,
        versionFileTemplate: config.versionFileTemplate,
        packageRepositoryUrl: config.packageRepositoryUrl,
        packageBranchName: config.packageBranchName,
        enabled: config.enabled,
      });
    },
  };
}
