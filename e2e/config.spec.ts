import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'child_process';

const testType = process.env.TEST_TYPE;
const baseURL = process.env.BASE_URL ?? '';

if (testType !== 'config') {
  test.skip(true, 'Config test is not supported for this test type');
} else {
  const runCommandChild = (
    command: string,
    args: string[] = [],
    options: Record<string, unknown> = {},
    callback: ((error: Error | null, result: { exitCode: number }) => void) | null
  ) => {
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
        } else if (code === null) {
          callback?.(null, { exitCode: 0 });
        } else {
          callback(new Error(`Command failed with exit code ${code}`), { exitCode: code });
        }
      });

      child.on('error', (error) => {
        callback?.(error, { exitCode: 1 });
      });
    }

    return child;
  };

  const waitServer = async (page: Page) => {
    const maxWaitTime = 120000; // 120 seconds in milliseconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      try {
        // Check if page is still open
        if (page.isClosed()) {
          throw new Error('Page was closed during server wait');
        }

        await page.goto(baseURL);
        await expect(page).toHaveURL(/\/p[tl]?\//, { timeout: 5000 });

        console.log('✅ Server is ready');

        return;
      } catch (error) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);

        console.log(`⏳ Waiting for server... (${elapsed}s/${maxWaitTime / 1000}s)`);

        // Check if page is still open before waiting
        if (page.isClosed()) {
          throw new Error('Page was closed during server wait');
        }

        await page.waitForTimeout(2000); // Wait 2 seconds before retry
      }
    }

    throw new Error(`Server did not become ready within ${maxWaitTime / 1000} seconds`);
  };

  let server: ReturnType<typeof spawn>;
  let page: Page;

  test.beforeEach(async ({ browser }) => {
    // Create a new page for the beforeAll hook
    page = await browser.newPage();

    // Start the server without -it flag to avoid TTY issues
    server = runCommandChild(
      'docker',
      ['exec', '-w', '/app/tests/test-commonjs', 'pp-dev-tests', 'npm run dev -- --host'],
      {},
      (error: Error | null, _result: { exitCode: number }) => {
        if (error) {
          console.error('❌ Server failed to start:', error);

        } else {
          console.log('✅ Server stopped successfully');
        }
      },
    );

    // Wait a bit for the server to start before checking
    await page.waitForTimeout(10000);
    await waitServer(page);
  });

  test.afterEach(async () => {
    // Close the page we created in beforeAll
    if (page) {
      await page.close();
    }

    server.kill();
  });

  test('config test', async ({ page }) => {
    await waitServer(page);
  });
}
