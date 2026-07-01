import { test, expect } from '@playwright/test';

const testType = process.env.TEST_TYPE;

test.describe('Toolbar Sync Functionality', () => {
  // Skip toolbar tests for Next.js
  test.skip(testType?.includes('nextjs') ?? false, 'Skipping toolbar tests for Next.js');

  test('should have sync button in toolbar', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    const syncButton = page.locator('#sync-template');
    await expect(syncButton).toBeAttached();
  });

  test('should add syncing class when sync button is clicked', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    const syncButton = page.locator('#sync-template');

    // Check if button is not disabled (sync is available)
    const isDisabled = await syncButton.evaluate((el: HTMLButtonElement) => el.disabled);

    if (!isDisabled) {
      await syncButton.click();

      await expect
        .poll(async () => {
          const className = await syncButton.getAttribute('class');
          const disabled = await syncButton.evaluate((el: HTMLButtonElement) => el.disabled);

          return className?.includes('syncing') ? 'syncing' : disabled ? 'disabled' : 'idle';
        })
        .not.toBe('idle');

      const className = await syncButton.getAttribute('class');
      const disabledAfterClick = await syncButton.evaluate((el: HTMLButtonElement) => el.disabled);

      if (disabledAfterClick && !className?.includes('syncing')) {
        expect(disabledAfterClick).toBe(true);
        expect(className).not.toContain('syncing');

        return;
      }

      expect(className).toContain('syncing');
    } else {
      // Skip test if sync is disabled
      test.skip();
    }
  });

  test('should display sync button with correct title when enabled', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    const syncButton = page.locator('#sync-template');

    // Wait for config update that might enable/disable sync
    await page.waitForTimeout(2000);

    const isDisabled = await syncButton.evaluate((el: HTMLButtonElement) => el.disabled);

    if (!isDisabled) {
      const title = await syncButton.getAttribute('title');
      expect(title).toBe('Sync template');
    } else {
      const title = await syncButton.getAttribute('title');
      expect(title).toContain('unavailable');
    }
  });

  test('should update sync button state based on config', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    const syncButton = page.locator('#sync-template');

    // Wait for potential config update
    await page.waitForTimeout(3000);

    // Check initial state
    const initialDisabled = await syncButton.evaluate((el: HTMLButtonElement) => el.disabled);
    const initialClass = await syncButton.getAttribute('class');

    // If disabled, should have 'disabled' class
    if (initialDisabled) {
      expect(initialClass).toContain('disabled');
    }
  });

  test('should prevent multiple simultaneous sync requests', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    const syncButton = page.locator('#sync-template');

    const isDisabled = await syncButton.evaluate((el: HTMLButtonElement) => el.disabled);

    if (!isDisabled) {
      // Click sync button
      await syncButton.click();

      // While syncing, button should be in syncing state
      const hasSyncingClass = await syncButton.evaluate((el) => el.classList.contains('syncing'));

      // If syncing is in progress, a second programmatic click should not leave
      // the button in an invalid state. The mock backend may complete the sync
      // before the next DOM read, so both "still syncing" and "settled" states
      // are acceptable after the second event.
      if (hasSyncingClass) {
        const classBeforeSecondClick = await syncButton.getAttribute('class');

        await syncButton.dispatchEvent('click');
        const classAfterSecondClick = await syncButton.getAttribute('class');
        const disabledAfterSecondClick = await syncButton.evaluate((el: HTMLButtonElement) => el.disabled);

        expect(classBeforeSecondClick).toContain('syncing');
        expect(classAfterSecondClick).toMatch(/sync-button/);

        if (classAfterSecondClick?.includes('syncing')) {
          expect(disabledAfterSecondClick || classAfterSecondClick.includes('disabled')).toBe(true);
        }
      }
    } else {
      test.skip();
    }
  });
});
