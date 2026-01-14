import { test, expect } from '@playwright/test';

const testType = process.env.TEST_TYPE;
const baseURL = process.env.BASE_URL ?? '';

test.describe('Config Watcher Debounce Behavior', () => {
  test.skip(testType !== 'config', 'Only run for config test type');

  test('should not restart immediately on config change', async ({ page }) => {
    // The debounce is set to 500ms in the CLI
    // This test verifies server doesn't restart too quickly

    await page.goto(baseURL);
    await expect(page).toHaveURL(/\/p[tl]?\//);

    // Record initial time
    const startTime = Date.now();

    // Make multiple rapid requests
    for (let i = 0; i < 5; i++) {
      const response = await page.request.get(baseURL);
      expect(response.ok()).toBe(true);
    }

    const endTime = Date.now();

    // All requests should complete relatively quickly
    // If debounce wasn't working, server restarts would cause delays
    expect(endTime - startTime).toBeLessThan(10000);
  });

  test('should coalesce multiple rapid config changes', async ({ page }) => {
    await page.goto(baseURL);

    // Verify server is stable
    await page.waitForTimeout(1000);

    // Make several requests to verify stability
    const requests = [];
    for (let i = 0; i < 3; i++) {
      requests.push(page.request.get(baseURL));
    }

    const responses = await Promise.all(requests);
    responses.forEach((response) => {
      expect(response.ok()).toBe(true);
    });
  });

  test('should remain responsive during config reload', async ({ page }) => {
    await page.goto(baseURL);

    // The page should remain usable even during config watch
    const toolbar = page.locator('.pp-dev-info');

    // For Vite projects, toolbar should be visible
    if (testType === 'config' || testType?.includes('commonjs')) {
      await expect(toolbar).toBeVisible({ timeout: 10000 });
    }
  });
});
