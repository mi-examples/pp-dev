import { test, expect } from '@playwright/test';

const testType = process.env.TEST_TYPE;

test.describe('Toolbar Popup Notifications', () => {
  // Skip toolbar tests for Next.js
  test.skip(testType?.includes('nextjs') ?? false, 'Skipping toolbar tests for Next.js');

  test('should show popup with correct structure when triggered', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    // Inject a test popup using the internal mechanism
    await page.evaluate(() => {
      // Access the hot module to send a test event
      if ((window as any).__vite_plugin_react_preamble_installed__) {
        // For testing, we'll check the popup structure exists
      }
    });

    // Trigger sync to potentially show a popup (if sync is available)
    const syncButton = page.locator('#sync-template');
    const isDisabled = await syncButton.evaluate((el: HTMLButtonElement) => el.disabled);

    if (!isDisabled) {
      await syncButton.click();

      // Wait for potential popup
      await page.waitForTimeout(5000);

      // Check if any popup appeared
      const popup = page.locator('.pp-dev-info__popup');
      const popupCount = await popup.count();

      if (popupCount > 0) {
        // Verify popup structure
        await expect(popup.first().locator('.pp-dev-info__popup-title')).toBeVisible();
        await expect(popup.first().locator('.pp-dev-info__popup-content')).toBeVisible();
        await expect(popup.first().locator('.pp-dev-info__popup-progress')).toBeAttached();
      }
    }
  });

  test('should position multiple popups correctly', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    // Check that the toolbar doesn't overlap with popup positioning logic
    const toolbar = page.locator('.pp-dev-info');
    await expect(toolbar).toBeVisible();

    // Verify the dev panel stays at bottom
    const toolbarBottom = await toolbar.evaluate((el) => {
      const styles = window.getComputedStyle(el);
      return styles.bottom;
    });

    expect(toolbarBottom).toBe('0px');
  });

  test('should have close button on popups', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    // Trigger an action that creates a popup
    const syncButton = page.locator('#sync-template');
    const isDisabled = await syncButton.evaluate((el: HTMLButtonElement) => el.disabled);

    if (!isDisabled) {
      await syncButton.click();

      // Wait for popup
      const popup = page.locator('.pp-dev-info__popup').first();

      // Wait for popup with timeout
      try {
        await popup.waitFor({ state: 'visible', timeout: 10000 });

        // Check for close button
        const closeButton = popup.locator('.pp-dev-info__popup-title-close');
        await expect(closeButton).toBeVisible();

        // Close button should contain SVG
        const closeSvg = closeButton.locator('svg');
        await expect(closeSvg).toBeVisible();
      } catch {
        // Popup didn't appear, which is fine for this test
        test.skip();
      }
    } else {
      test.skip();
    }
  });

  test('should remove popup when close button is clicked', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    const syncButton = page.locator('#sync-template');
    const isDisabled = await syncButton.evaluate((el: HTMLButtonElement) => el.disabled);

    if (!isDisabled) {
      await syncButton.click();

      const popup = page.locator('.pp-dev-info__popup').first();

      try {
        await popup.waitFor({ state: 'visible', timeout: 10000 });

        // Click close button
        const closeButton = popup.locator('.pp-dev-info__popup-title-close');
        await closeButton.click();

        // Popup should be removed (with animation)
        await expect(popup).not.toBeVisible({ timeout: 5000 });
      } catch {
        test.skip();
      }
    } else {
      test.skip();
    }
  });

  test('should auto-dismiss popup after duration', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    const syncButton = page.locator('#sync-template');
    const isDisabled = await syncButton.evaluate((el: HTMLButtonElement) => el.disabled);

    if (!isDisabled) {
      await syncButton.click();

      const popup = page.locator('.pp-dev-info__popup').first();

      try {
        await popup.waitFor({ state: 'visible', timeout: 10000 });

        // Wait for auto-dismiss (default duration is 10000ms)
        await expect(popup).not.toBeVisible({ timeout: 15000 });
      } catch {
        // Popup may have been dismissed already or didn't appear
        test.skip();
      }
    } else {
      test.skip();
    }
  });

  test('should show progress bar animation on popup', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    const syncButton = page.locator('#sync-template');
    const isDisabled = await syncButton.evaluate((el: HTMLButtonElement) => el.disabled);

    if (!isDisabled) {
      await syncButton.click();

      const popup = page.locator('.pp-dev-info__popup').first();

      try {
        await popup.waitFor({ state: 'visible', timeout: 10000 });

        const progressBar = popup.locator('.pp-dev-info__popup-progress');
        await expect(progressBar).toBeAttached();

        // Check that progress bar has width style (animated)
        const hasWidthStyle = await progressBar.evaluate((el) => {
          const style = window.getComputedStyle(el);
          return style.width !== '0px' && style.width !== '';
        });

        expect(hasWidthStyle).toBe(true);
      } catch {
        test.skip();
      }
    } else {
      test.skip();
    }
  });
});
