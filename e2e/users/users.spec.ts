import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * Working as other MI users (PP-4592): every saved user has its own host, `<name>.localhost`, and
 * the proxy sends that host's requests to MI as that user. Runs against the replay mock, which
 * logs the requests it gets (`/__mock-mi/requests`), so the tests can see whom MI was asked as.
 */

const mockUrl = process.env.MOCK_MI_URL;
// Compared, never printed: locally this is a real token from the fixture's .env.
const originalAuthorization = `Bearer ${process.env.MI_ACCESS_TOKEN}`;

const VIEWER = { name: 'e2e-viewer', token: 'e2e-viewer-token' };

function userOrigin(baseURL: string, name: string): string {
  const url = new URL(baseURL);

  return `${url.protocol}//${name}.localhost:${url.port}`;
}

async function mockRequests(request: APIRequestContext): Promise<{ path: string; authorization?: string }[]> {
  return (await request.get(`${mockUrl}/__mock-mi/requests`)).json();
}

test.describe('Users', () => {
  test.skip(!mockUrl, 'Needs the replay mock: run through scripts/run-playwright-e2e.ts');

  test.afterEach(async ({ request, baseURL }) => {
    await request.put(`${baseURL}/@api/users/default`, { data: { name: null } });

    const { users } = await (await request.get(`${baseURL}/@api/users`)).json();

    for (const user of users as { name: string }[]) {
      await request.delete(`${baseURL}/@api/users/${user.name}`);
    }
  });

  test("a token user's tab goes to MI with its token, the main tab with yours", async ({ page, request, baseURL }) => {
    const added = await request.post(`${baseURL}/@api/users`, { data: VIEWER });

    expect(added.status()).toBe(201);
    expect(JSON.stringify(await added.json())).not.toContain(VIEWER.token);

    await request.delete(`${mockUrl}/__mock-mi/requests`);
    await page.goto(userOrigin(baseURL!, VIEWER.name));
    await expect(page.locator('.pp-dev-info.pp-dev-info--user-tab')).toBeVisible();
    await page.waitForTimeout(1500);

    const asViewer = await mockRequests(request);

    expect(asViewer.some((r) => r.authorization === `Bearer ${VIEWER.token}`)).toBe(true);

    await request.delete(`${mockUrl}/__mock-mi/requests`);
    await page.goto(baseURL!);
    await expect(page.locator('.pp-dev-info')).toBeVisible();
    await expect(page.locator('.pp-dev-info--user-tab')).toHaveCount(0);
    await page.waitForTimeout(1500);

    const asYou = await mockRequests(request);

    expect(asYou.length).toBeGreaterThan(0);
    expect(asYou.some((r) => r.authorization === originalAuthorization)).toBe(true);
    expect(asYou.some((r) => r.authorization === `Bearer ${VIEWER.token}`)).toBe(false);
  });

  test('a user host with no saved user is turned away', async ({ page, baseURL }) => {
    const response = await page.goto(userOrigin(baseURL!, 'e2e-ghost'));

    expect(response?.status()).toBe(404);
    await expect(page.locator('body')).toContainText('pp-dev has no user named "e2e-ghost"');
  });

  test("a user's host keeps its own cookies", async ({ context, request, baseURL }) => {
    await request.post(`${baseURL}/@api/users`, { data: VIEWER });

    const main = await context.newPage();

    await main.goto(baseURL!);
    await main.evaluate(() => {
      document.cookie = 'e2e-host=main; path=/';
    });

    const user = await context.newPage();

    await user.goto(userOrigin(baseURL!, VIEWER.name));

    expect(await user.evaluate(() => document.cookie)).not.toContain('e2e-host=main');
  });

  test('the dev server WebSockets connect on a user host', async ({ page, request, baseURL }) => {
    await request.post(`${baseURL}/@api/users`, { data: VIEWER });

    const sockets: { url: string; closed: boolean }[] = [];

    page.on('websocket', (ws) => {
      const entry = { url: ws.url(), closed: false };

      sockets.push(entry);
      ws.on('close', () => (entry.closed = true));
    });

    await page.goto(userOrigin(baseURL!, VIEWER.name));
    await page.waitForTimeout(3000);

    const onUserHost = sockets.filter((s) => new URL(s.url).hostname === `${VIEWER.name}.localhost`);

    expect(onUserHost.length).toBeGreaterThan(0);
    expect(onUserHost.every((s) => !s.closed)).toBe(true);
  });

  test('logging out as a saved user drops it and lands on the main host', async ({ page, request, baseURL }) => {
    await request.post(`${baseURL}/@api/users`, { data: VIEWER });
    await page.goto(`${userOrigin(baseURL!, VIEWER.name)}/auth/index/logout`);

    expect(new URL(page.url()).hostname).toBe('localhost');

    const { users } = await (await request.get(`${baseURL}/@api/users`)).json();

    expect(users).toEqual([]);
  });

  test('the Users popover adds a user and opens the page as that user', async ({ page, context, baseURL }) => {
    await page.goto(baseURL!);
    await page.locator('.pp-dev-info__users-btn').click();

    const popover = page.locator('.pp-dev-info__users');

    await expect(popover).toBeVisible();
    await popover.locator('.pp-dev-info__users-name-input').fill('e2e-panel');
    await popover.locator('.pp-dev-info__users-token').fill('e2e-panel-token');
    await popover.locator('.pp-dev-info__users-submit').click();

    const row = popover.locator('[data-user="e2e-panel"]');

    await expect(row).toContainText('API token');

    const [opened] = await Promise.all([
      context.waitForEvent('page'),
      row.getByRole('button', { name: 'Open' }).click(),
    ]);

    await opened.waitForLoadState();

    expect(new URL(opened.url()).hostname).toBe('e2e-panel.localhost');
    await expect(opened.locator('.pp-dev-info.pp-dev-info--user-tab')).toBeVisible();
  });
});
