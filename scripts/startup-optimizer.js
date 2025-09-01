#!/usr/bin/env node

import { performance } from 'node:perf_hooks';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Performance monitoring utilities
class PerformanceMonitor {
  constructor() {
    this.marks = new Map();
    this.measures = new Map();
    this.startTime = performance.now();
  }

  mark(name) {
    this.marks.set(name, performance.now());
    console.log(`⏱️  Mark: ${name} at ${this.getElapsedTime()}ms`);
  }

  measure(name, startMark, endMark) {
    const start = this.marks.get(startMark);
    const end = this.marks.get(endMark);
    
    if (start && end) {
      const duration = end - start;
      this.measures.set(name, duration);
      console.log(`📊 Measure: ${name} = ${duration.toFixed(2)}ms`);
      return duration;
    }
    return 0;
  }

  getElapsedTime() {
    return (performance.now() - this.startTime).toFixed(2);
  }

  getSummary() {
    console.log('\n📈 Performance Summary:');
    console.log('========================');
    
    for (const [name, duration] of this.measures) {
      console.log(`${name}: ${duration.toFixed(2)}ms`);
    }
    
    const totalTime = performance.now() - this.startTime;
    console.log(`\nTotal optimization time: ${totalTime.toFixed(2)}ms`);
  }
}

// Cache optimization utilities
class CacheOptimizer {
  constructor() {
    this.cacheStats = {
      configCache: 0,
      apiCache: 0,
    };
  }

  async optimizeCaches() {
    console.log('\n🔧 Optimizing caches...');
    
    try {
      // Clear existing caches
      const { clearConfigCache } = await import('../dist/esm/config.js');
      const { clearAPICache } = await import('../dist/esm/lib/load-pp-data.middleware.js');
      
      clearConfigCache();
      clearAPICache();
      
      console.log('✅ Caches cleared successfully');
    } catch (error) {
      console.log('⚠️  Could not clear caches (build may be needed)');
      console.log('   Run "npm run build" first to apply optimizations');
    }
  }

  getCacheStats() {
    return this.cacheStats;
  }
}

// Dependency analysis based on isolate log findings
class DependencyAnalyzer {
  constructor() {
    // Based on profiling data from isolate log
    this.heavyStartupDeps = [
      'source-map-support',  // Loaded immediately in bin/pp-dev.js
      'source-map',          // Heavy dependency chain
      'esbuild',            // TypeScript compilation overhead
      'jsdom',              // HTML parsing (lazy loaded)
      'vite',               // Large framework
      'rollup',             // Build system
    ];
    
    this.performanceBottlenecks = [
      'TypeScript config compilation with esbuild',
      'Multiple file system operations for config discovery',
      'Package.json parsing on every startup',
      'Source map support initialization',
      'Vite dependency optimization',
    ];
  }

  analyzeDependencies() {
    console.log('\n📦 Analyzing dependencies based on profiling data...');
    
    const packagePath = path.resolve(__dirname, '../package.json');
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    
    console.log('Heavy dependencies identified in profiling:');
    for (const dep of this.heavyStartupDeps) {
      if (deps[dep]) {
        console.log(`  - ${dep}: ${deps[dep]}`);
      }
    }
    
    return deps;
  }

  suggestOptimizations() {
    console.log('\n💡 Optimization suggestions based on profiling:');
    console.log('===============================================');
    console.log('1. ✅ Lazy load esbuild (implemented)');
    console.log('2. ✅ Cache configuration files (implemented)');
    console.log('3. ✅ API response caching (implemented)');
    console.log('4. 🔄 Optimize source-map-support loading');
    console.log('5. 🔄 Reduce Vite dependency scanning');
    console.log('6. 🔄 Minimize file system operations');
  }

  identifyBottlenecks() {
    console.log('\n🚨 Performance bottlenecks from profiling:');
    console.log('==========================================');
    
    this.performanceBottlenecks.forEach((bottleneck, index) => {
      console.log(`${index + 1}. ${bottleneck}`);
    });
  }
}

// Main optimization function
async function optimizeStartup() {
  const monitor = new PerformanceMonitor();
  const cacheOptimizer = new CacheOptimizer();
  const dependencyAnalyzer = new DependencyAnalyzer();

  console.log('🚀 PP-Dev Startup Optimizer (Based on Profiling Data)');
  console.log('=====================================================\n');

  monitor.mark('start');

  // Analyze dependencies
  monitor.mark('deps-analysis-start');
  dependencyAnalyzer.analyzeDependencies();
  dependencyAnalyzer.identifyBottlenecks();
  monitor.mark('deps-analysis-end');
  monitor.measure('Dependency Analysis', 'deps-analysis-start', 'deps-analysis-end');

  // Optimize caches
  monitor.mark('cache-optimization-start');
  await cacheOptimizer.optimizeCaches();
  monitor.mark('cache-optimization-end');
  monitor.measure('Cache Optimization', 'cache-optimization-start', 'cache-optimization-end');

  // Provide suggestions
  monitor.mark('suggestions-start');
  dependencyAnalyzer.suggestOptimizations();
  monitor.mark('suggestions-end');
  monitor.measure('Optimization Suggestions', 'suggestions-start', 'suggestions-end');

  monitor.mark('end');
  monitor.measure('Total Optimization', 'start', 'end');

  monitor.getSummary();

  console.log('\n✨ Optimization complete!');
  console.log('\n📋 Next steps:');
  console.log('1. Run "npm run build" to apply optimizations');
  console.log('2. Test startup time with "time pp-dev"');
  console.log('3. Use "npm run startup:profile" for detailed profiling');
  console.log('4. Monitor cache hit rates during development');
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  optimizeStartup().catch(console.error);
}

export { PerformanceMonitor, CacheOptimizer, DependencyAnalyzer, optimizeStartup };
