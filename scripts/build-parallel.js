import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: true
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

async function buildParallel() {
  const projectRoot = resolve(__dirname, '..');
  
  try {
    console.log('🚀 Starting parallel build...');
    
    // Start both builds concurrently
    const nodeBuild = runCommand('npm', ['run', 'build:node'], projectRoot);
    const clientBuild = runCommand('npm', ['run', 'build:client'], projectRoot);
    
    // Wait for both to complete
    await Promise.all([nodeBuild, clientBuild]);
    
    console.log('✅ Parallel build completed successfully!');
    
  } catch (error) {
    console.error('❌ Parallel build failed:', error.message);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  buildParallel();
}

export { buildParallel };
