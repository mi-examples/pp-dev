import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class BuildOptimizer {
  constructor() {
    this.projectRoot = resolve(__dirname, '..');
    this.packageJsonPath = resolve(this.projectRoot, 'package.json');
    this.packageJson = JSON.parse(readFileSync(this.packageJsonPath, 'utf-8'));
  }

  // Analyze bundle sizes
  async analyzeBundleSizes() {
    console.log('📊 Analyzing bundle sizes...');
    
    try {
      // Check if rollup-plugin-visualizer is available
      if (this.packageJson.devDependencies['rollup-plugin-visualizer']) {
        execSync('npm run build:analyze', { 
          cwd: this.projectRoot, 
          stdio: 'inherit' 
        });
        console.log('✅ Bundle analysis completed');
      } else {
        console.log('⚠️  rollup-plugin-visualizer not available, skipping analysis');
      }
    } catch (error) {
      console.log('⚠️  Bundle analysis failed:', error.message);
    }
  }

  // Optimize TypeScript compilation
  optimizeTypeScript() {
    console.log('⚡ Optimizing TypeScript configuration...');
    
    const tsConfigs = [
      'tsconfig.json',
      'tsconfig.esm.json',
      'tsconfig.cjs.json',
      'tsconfig.types.json'
    ];

    tsConfigs.forEach(configFile => {
      const configPath = resolve(this.projectRoot, configFile);
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        
        // Add performance optimizations
        if (config.compilerOptions) {
          config.compilerOptions.incremental = true;
          config.compilerOptions.tsBuildInfoFile = './dist/.tsbuildinfo';
          config.compilerOptions.assumeChangesOnlyAffectDirectDependencies = true;
        }
        
        writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`✅ Optimized ${configFile}`);
      }
    });
  }

  // Generate build performance report
  generateBuildReport() {
    console.log('📈 Generating build performance report...');
    
    const report = {
      timestamp: new Date().toISOString(),
      package: this.packageJson.name,
      version: this.packageJson.version,
      buildScripts: this.packageJson.scripts,
      dependencies: {
        total: Object.keys(this.packageJson.dependencies || {}).length,
        dev: Object.keys(this.packageJson.devDependencies || {}).length,
        peer: Object.keys(this.packageJson.peerDependencies || {}).length,
      },
      buildOptimizations: [
        'Cross-platform parallel builds enabled',
        'Enhanced tree-shaking',
        'Optimized TypeScript compilation',
        'Bundle analysis support',
        'Improved source maps',
        'Better external dependency handling'
      ],
      recommendations: [
        'Use `npm run build:fast` for quick builds',
        'Use `npm run build:parallel` for production builds',
        'Use `npm run build:analyze` to analyze bundle sizes',
        'Consider using `npm run build:watch` for development'
      ]
    };

    const reportPath = resolve(this.projectRoot, 'dist/build-report.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`✅ Build report generated: ${reportPath}`);
    
    return report;
  }

  // Run all optimizations
  async optimize() {
    console.log('🚀 Starting build optimization...\n');
    
    this.optimizeTypeScript();
    await this.analyzeBundleSizes();
    const report = this.generateBuildReport();
    
    console.log('\n🎉 Build optimization completed!');
    console.log('\n📋 Summary:');
    console.log(`   Package: ${report.package}@${report.version}`);
    console.log(`   Dependencies: ${report.dependencies.total} runtime, ${report.dependencies.dev} dev`);
    console.log(`   Optimizations applied: ${report.buildOptimizations.length}`);
    
    console.log('\n💡 Quick start:');
    report.recommendations.forEach(rec => console.log(`   ${rec}`));
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const optimizer = new BuildOptimizer();
  optimizer.optimize().catch(console.error);
}

export { BuildOptimizer };
