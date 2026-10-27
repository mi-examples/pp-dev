import { test, expect, type Locator, type Page } from '@playwright/test';

const testType = process.env.TEST_TYPE;

type ButtonState = { syncing: boolean; disabled: boolean };

async function recordButtonStates(button: Locator) {
  await button.evaluate((el: HTMLButtonElement) => {
    const states: ButtonState[] = [];

    (window as unknown as { __syncButtonStates: ButtonState[] }).__syncButtonStates = states;
    new MutationObserver(() => {
      states.push({ syncing: el.classList.contains('syncing'), disabled: el.disabled });
    }).observe(el, { attributes: true, attributeFilter: ['class', 'disabled'] });
  });
}

function recordedStates(page: Page) {
  return page.evaluate(() => (window as unknown as { __syncButtonStates: ButtonState[] }).__syncButtonStates);
}

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

  // The mock backend answers a sync within milliseconds, faster than polling the DOM can catch, so
  // every state the button goes through is recorded instead.
  test('should show the syncing state while a sync runs, and recover once it ends', async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error('baseURL is not set');
    }

    await page.goto(baseURL);

    const syncButton = page.locator('#sync-template');

    if (await syncButton.evaluate((el: HTMLButtonElement) => el.disabled)) {
      test.skip();

      return;
    }

    await recordButtonStates(syncButton);
    await syncButton.click();

    // While the sync runs, the button spins and can't be clicked again.
    await expect.poll(() => recordedStates(page)).toContainEqual({ syncing: true, disabled: true });

    // Whatever the sync's outcome, its response ends the syncing state. Only "sync unavailable on
    // this instance" leaves the button disabled; a failed sync can be retried.
    await expect(syncButton).not.toHaveClass(/\bsyncing\b/, { timeout: 15_000 });

    const unavailable = await syncButton.evaluate((el) => el.classList.contains('disabled'));

    await expect(syncButton).toBeEnabled({ enabled: !unavailable });
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

    // Count the sync requests the panel actually sends over the dev-server WebSocket.
    let syncRequests = 0;

    page.on('websocket', (ws) => {
      ws.on('framesent', ({ payload }) => {
        if (typeof payload === 'string' && /"event":"template:sync"/.test(payload)) {
          syncRequests += 1;
        }
      });
    });

    await page.goto(baseURL);

    const syncButton = page.locator('#sync-template');

    if (await syncButton.evaluate((el: HTMLButtonElement) => el.disabled)) {
      test.skip();

      return;
    }

    // Two clicks in one task: the second lands on the button the first one just disabled.
    await syncButton.evaluate((el: HTMLButtonElement) => {
      el.click();
      el.click();
    });

    await expect(syncButton).not.toHaveClass(/\bsyncing\b/, { timeout: 15_000 });
    expect(syncRequests).toBe(1);
  });

});
