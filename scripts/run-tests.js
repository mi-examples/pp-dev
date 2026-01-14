import { spawn } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// Parse command line arguments using yargs
const argv = yargs(hideBin(process.argv))
  .option('test-types', {
    alias: 't',
    type: 'array',
    description: 'Test types to run (dev-commonjs, dev-nextjs, dev-nextjs-cjs)',
    default: ['dev-commonjs', 'dev-nextjs', 'dev-nextjs-cjs'],
  })
  .option('all', {
    alias: 'a',
    type: 'boolean',
    description: 'Run all test types',
    default: false,
  })
  .option('help', {
    alias: 'h',
    type: 'boolean',
    description: 'Show help information',
  })
  .option('interactive', {
    alias: 'i',
    type: 'boolean',
    description: 'Run in interactive mode',
    default: false,
  })
  .help().argv;

// Determine test types to run
let testTypes = [];

if (argv.all) {
  testTypes = ['dev-commonjs', 'dev-nextjs', 'dev-nextjs-cjs'];
} else if (argv.testTypes && argv.testTypes.length > 0) {
  testTypes = argv.testTypes;
} else {
  // Fallback to positional arguments for backward compatibility
  const positionalArgs = argv._;

  if (positionalArgs.includes('all')) {
    testTypes = ['dev-commonjs', 'dev-nextjs', 'dev-nextjs-cjs'];
  } else if (positionalArgs.length > 0) {
    testTypes = positionalArgs;
  } else {
    testTypes = ['dev-commonjs', 'dev-nextjs', 'dev-nextjs-cjs'];
  }
}

const testFolders = new Map(testTypes.map((type) => [type, `test-${type.replace(/^dev-/, '')}`]));

let port = 3005;
let runningContainers = [];

const runCommand = (command, args = [], options = {}) => {
  return new Promise((resolve, reject) => {
    console.log(`Running: ${command} ${args.join(' ')}`);

    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: true,
      ...options,
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else if (code === 137) {
        // SIGKILL - not an error, container was killed
        console.log(`✅ Command ${command} was SIGKILLed (exit code 137)`);
        resolve();
      } else if (code === 139) {
        // SIGSEGV - not an error, container segfaulted
        console.log(`✅ Command ${command} had SIGSEGV (exit code 139)`);
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
};

// Run command with input
const runCommandChild = (command, args = [], options = {}, callback) => {
  const child = spawn(command, args, {
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: true,
    ...options,
  });

  if (callback) {
    child.on('close', (code) => {
      if (code === 0) {
        callback(null, { exitCode: code });
      } else if (code === 137) {
        // SIGKILL - not an error, container was killed
        console.log(`✅ Command ${command} was SIGKILLed (exit code 137)`);
        callback(null, { exitCode: code });
      } else if (code === 139) {
        // SIGSEGV - not an error, container segfaulted
        console.log(`✅ Command ${command} had SIGSEGV (exit code 139)`);
        callback(null, { exitCode: code });
      } else {
        callback(new Error(`Command failed with exit code ${code}`), { exitCode: code });
      }
    });

    child.on('error', (error) => {
      callback(error, null);
    });
  }

  return child;
};

// Run command as shell

let hasCleanup = false;

const cleanup = async () => {
  hasCleanup = true;

  console.log('\n🛑 Received interrupt signal. Cleaning up...');

  for (const container of runningContainers) {
    try {
      console.log(`Stopping container: ${container}`);
      await runCommand('docker', ['stop', container]);
      console.log(`Removed container: ${container}`);
    } catch (error) {
      console.log(`Container ${container} may already be stopped`);
    }
  }

  try {
    console.log('Removing Docker image...');
    await runCommand('docker', ['rmi', 'pp-dev-tests', '--force']);
  } catch (error) {
    console.log('Docker image may already be removed');
  }

  console.log('✅ Cleanup completed');
  process.exit(0);
};

// Handle Ctrl+C and other termination signals
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('SIGQUIT', cleanup);

const main = async () => {
  try {
    await runCommand('docker', ['build', '-f', './Dockerfile', '-t', 'pp-dev-tests', '.']);

    const configPort = 3004;

    // Test helper configuration
    runCommand('docker', [
      'run',
      '--rm',
      '-it',
      '-p',
      `${configPort}:3000`,
      '-v',
      `${path.resolve(process.cwd(), 'tests')}:/app/tests`,
      '-v',
      '/app/tests/test-commonjs',
      '--name',
      'pp-dev-tests',
      '--entrypoint',
      'sh',
      'pp-dev-tests',
    ]).catch((error) => {
      runCommand('docker', ['rmi', 'pp-dev-tests', '--force']);
      process.exit(1);
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });

    await runCommand('docker', ['exec', '-it', '-w', '/app/tests/test-commonjs', 'pp-dev-tests', 'npm run reinstall']);

    // Run playwright tests
    await runCommand('npx', ['playwright', 'test', 'e2e/config.spec.ts'], {
      env: { ...process.env, BASE_URL: `http://localhost:${configPort}`, TEST_TYPE: 'config' },
    }).catch(async (error) => {
      await runCommand('docker', ['stop', 'pp-dev-tests']);
      await runCommand('docker', ['rmi', 'pp-dev-tests', '--force']);

      console.error('❌ Error:', error.message);

      process.exit(1);
    });

    await runCommand('docker', ['stop', 'pp-dev-tests']);

    for (const folder of testTypes) {
      console.log(`\n🚀 Starting tests for ${folder}...`);

      // Start container in detached mode
      runCommand('docker', [
        'run',
        '--rm',
        '-p',
        `${port}:3000`,
        '-v',
        `${path.resolve(process.cwd(), 'tests', testFolders.get(folder))}:/app/tests/${testFolders.get(folder)}`,
        '--name',
        testFolders.get(folder),
        'pp-dev-tests',
        folder,
      ]);
      console.log(`✅ Container ${testFolders.get(folder)} started`);
      runningContainers.push(testFolders.get(folder));

      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });

      // Wait for server to start in container
      await new Promise((resolve, reject) => {
        const maxAttempts = 240; // 240 seconds timeout
        let attempts = 0;
        console.log(`Checking server on port ${port}`);

        const checkServer = async () => {
          // check if container is running
          const container = await promisify(exec)(`docker ps --filter name=${testFolders.get(folder)}`);

          if (!container.stdout.includes(testFolders.get(folder))) {
            reject(new Error('Container not running'));

            return;
          }

          if (hasCleanup) {
            reject(new Error('Cleanup signal received'));

            return;
          }

          try {
            const response = await fetch(`http://localhost:${port}`);

            if (response.ok) {
              console.log(`✅ Server is ready on port ${port}`);

              resolve();
            } else {
              throw new Error(`Server responded with status ${response.status}`);
            }
          } catch (error) {
            attempts++;

            if (attempts >= maxAttempts) {
              reject(new Error(`Server failed to start within ${maxAttempts} seconds`));

              return;
            }

            console.log(`⏳ Waiting for server... (attempt ${attempts}/${maxAttempts})`);
            setTimeout(checkServer, 1000);
          }
        };

        checkServer();
      });

      // Run playwright tests
      await runCommand('npx', ['playwright', 'test'], {
        env: { ...process.env, BASE_URL: `http://localhost:${port}`, TEST_TYPE: folder },
      });

      await runCommand('docker', ['stop', testFolders.get(folder)]);
      // Clean up this container
      await runCommand('docker', ['rmi', testFolders.get(folder), '--force']);

      // Remove from running containers list
      runningContainers = runningContainers.filter((c) => c !== testFolders.get(folder));

      console.log(`✅ Tests completed for ${testFolders.get(folder)}`);
      port++;
    }

    // Final cleanup
    await runCommand('docker', ['rmi', 'pp-dev-tests', '--force']);
    console.log('\n🎉 All tests completed successfully!');
  } catch (error) {
    console.error('❌ Error:', error.message);
    await cleanup();
  }
};

main().finally(() => {
  cleanup();
});
