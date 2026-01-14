import { test, expect } from '@playwright/test';

const testType = process.env.TEST_TYPE;

test.describe('Toolbar Visibility', () => {
  // Skip toolbar tests for Next.js as it doesn't inject the toolbar in the same way
  test.skip(testType?.includes('nextjs') ?? false, 'Skipping toolbar tests for Next.js');

  test('should display pp-dev toolbar on page load', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    // Wait for the toolbar to be visible
    const toolbar = page.locator('.pp-dev-info');
    await expect(toolbar).toBeVisible({ timeout: 10000 });
  });

  test('should have the pp-dev-info-namespace class', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    const namespace = page.locator('.pp-dev-info-namespace');
    await expect(namespace).toBeVisible();
  });

  test('should display minimize button', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    const minimizeBtn = page.locator('.pp-dev-info__wrap-btn');
    await expect(minimizeBtn).toBeVisible();
  });

  test('should display sync button when available', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    const syncButton = page.locator('#sync-template');
    // Sync button may be disabled but should exist
    await expect(syncButton).toBeAttached();
  });

  test('should have correct toolbar structure', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    // Check for main toolbar elements
    const toolbar = page.locator('.pp-dev-info');
    await expect(toolbar).toBeVisible();

    // Check that toolbar has SVG icons
    const svgIcons = toolbar.locator('svg');
    expect(await svgIcons.count()).toBeGreaterThan(0);
  });

  test('should be positioned at the bottom of the page', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    const toolbar = page.locator('.pp-dev-info');
    await expect(toolbar).toBeVisible();

    // Check CSS positioning
    const bottom = await toolbar.evaluate((el) => {
      const styles = window.getComputedStyle(el);
      return styles.bottom;
    });

    // Should be positioned at the bottom
    expect(bottom).toBe('0px');
  });
});
