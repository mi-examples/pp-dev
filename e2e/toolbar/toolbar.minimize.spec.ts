import { test, expect, type Locator } from '@playwright/test';

const testType = process.env.TEST_TYPE;

async function waitForPanelTransition(minimizeBtn: Locator): Promise<void> {
  await minimizeBtn.evaluate(async (button) => {
    const panel = button.closest('.pp-dev-info');

    await Promise.all(panel?.getAnimations().map((animation) => animation.finished) ?? []);
  });
}

test.describe('Toolbar Minimize Functionality', () => {
  // Skip toolbar tests for Next.js
  test.skip(testType?.includes('nextjs') ?? false, 'Skipping toolbar tests for Next.js');

  test('should minimize toolbar when minimize button is clicked', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    const toolbar = page.locator('.pp-dev-info');
    const minimizeBtn = page.locator('.pp-dev-info__wrap-btn');

    // Wait for toolbar to be visible
    await expect(toolbar).toBeVisible();

    // Ensure toolbar is not minimized initially (unless localStorage has previous state)
    // Clear localStorage to ensure fresh state
    await page.evaluate(() => localStorage.removeItem('pp-dev-info-closed'));
    await page.reload();

    await expect(toolbar).toBeVisible();

    // Click minimize button
    await minimizeBtn.click({ force: true });

    // Toolbar should have 'closed' class
    await expect(toolbar).toHaveClass(/closed/);
  });

  test('should restore toolbar when minimize button is clicked again', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    // Clear localStorage to ensure fresh state
    await page.evaluate(() => localStorage.removeItem('pp-dev-info-closed'));
    await page.reload();

    const toolbar = page.locator('.pp-dev-info');
    const minimizeBtn = page.locator('.pp-dev-info__wrap-btn');

    await expect(toolbar).toBeVisible();

    // Minimize
    await minimizeBtn.click({ force: true });
    await expect(toolbar).toHaveClass(/closed/);

    await waitForPanelTransition(minimizeBtn);

    // Restore
    await minimizeBtn.click({ force: true });
    await expect(toolbar).not.toHaveClass(/closed/);
  });

  test('should persist minimize state in localStorage', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    // Clear previous state
    await page.evaluate(() => localStorage.removeItem('pp-dev-info-closed'));
    await page.reload();

    const toolbar = page.locator('.pp-dev-info');
    const minimizeBtn = page.locator('.pp-dev-info__wrap-btn');

    // Minimize toolbar
    await minimizeBtn.click({ force: true });
    await expect(toolbar).toHaveClass(/closed/);

    // Check localStorage value
    const storageValue = await page.evaluate(() => localStorage.getItem('pp-dev-info-closed'));
    expect(storageValue).toBe('true');

    // Reload page
    await page.reload();

    // Toolbar should still be minimized
    await expect(toolbar).toHaveClass(/closed/);
  });

  test('should restore state from localStorage on page load', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    // Set localStorage before navigating
    await page.goto(baseURL);
    await page.evaluate(() => localStorage.setItem('pp-dev-info-closed', 'true'));
    await page.reload();

    const toolbar = page.locator('.pp-dev-info');

    // Should be minimized based on localStorage
    await expect(toolbar).toHaveClass(/closed/);
  });

  test('should toggle SVG icon class when minimizing', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);
    await page.evaluate(() => localStorage.removeItem('pp-dev-info-closed'));
    await page.reload();

    const minimizeBtn = page.locator('.pp-dev-info__wrap-btn');
    const minimizeSvg = minimizeBtn.locator('svg');

    // Click to minimize
    await minimizeBtn.click({ force: true });

    // SVG should have 'closed' class
    await expect(minimizeSvg).toHaveClass(/closed/);

    // The panel moves while minimizing. Wait for that transition so the next mouse click
    // targets the button at its settled position instead of coordinates it has already left.
    await waitForPanelTransition(minimizeBtn);

    // Click to restore
    await minimizeBtn.click({ force: true });

    // SVG should not have 'closed' class
    await expect(minimizeSvg).not.toHaveClass(/closed/);
  });
});
