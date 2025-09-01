import { build } from 'esbuild';
import * as path from 'path';
import * as fs from 'fs';

// Read package.json
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));

// Common build options
const commonOptions = {
  bundle: true,
  minify: true,
  sourcemap: true,
  target: 'node20' as const,
  platform: 'node' as const,
  external: [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
  ],
  outdir: 'dist/esbuild',
  format: 'esm' as const,
  splitting: true,
  metafile: true,
  treeShaking: true,
};

// Build function
async function buildWithEsbuild() {
  try {
    console.log('🚀 Starting esbuild build...');
    
    // Build main package
    const result = await build({
      ...commonOptions,
      entryPoints: {
        index: 'src/index.ts',
        plugin: 'src/plugin.ts',
        cli: 'src/cli.ts',
        helpers: 'src/helpers.ts',
      },
    });

    // Build client (without SCSS for now - just TypeScript)
    await build({
      ...commonOptions,
      entryPoints: ['src/client/index.ts'],
      outdir: 'dist/esbuild/client',
    });

    console.log('✅ Esbuild build completed successfully!');
    console.log('📊 Build metadata:', result.metafile);
    
  } catch (error) {
    console.error('❌ Esbuild build failed:', error);
    process.exit(1);
  }
}

// Run build if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  buildWithEsbuild();
}

export { buildWithEsbuild };
