import { test, expect } from '@playwright/test';

const testType = process.env.TEST_TYPE;

test('is redirected to the page', async ({ page, baseURL }) => {
  if (!baseURL) {
    throw new Error('baseURL is not set');
  }

  console.log(`🌐 Starting test with baseURL: ${baseURL}`);

  // Step 1: Navigate to base URL
  await test.step('Navigate to base URL', async () => {
    await page.goto(baseURL);
    console.log(`📍 Navigated to: ${page.url()}`);
  });
  
  // Step 2: Verify redirection occurred
  await test.step('Verify redirection occurred', async () => {
    const currentUrl = page.url();
    console.log(`📍 Current URL after navigation: ${currentUrl}`);
    
    // Verify we were redirected away from the base URL
    await expect(page).not.toHaveURL(baseURL);
    console.log(`✅ Successfully redirected away from base URL`);
  });

  // Step 3: Verify final URL pattern
  await test.step('Verify final URL pattern', async () => {
    const urlRegex = new RegExp(`^${baseURL}/p[tl]?/`);
    const finalUrl = page.url();
    
    console.log(`🔗 Testing URL pattern: ${urlRegex}`);
    console.log(`📍 Final URL: ${finalUrl}`);
    
    // Verify the final URL matches the expected pattern
    expect(finalUrl).toMatch(urlRegex);
    
    console.log(`✅ Final URL matches expected pattern: ${finalUrl}`);
  });
});

test('pp-dev toolbar is available', async ({ page, baseURL }) => {
  if (!baseURL) {
    throw new Error('baseURL is not set');
  }

  await page.goto(baseURL);

  // Helper class name "pp-dev-info"

  test.skip(testType?.includes('nextjs') ?? false, 'Skipping toolbar test for Next.js');

  await expect(page.locator('.pp-dev-info')).toBeVisible();
});