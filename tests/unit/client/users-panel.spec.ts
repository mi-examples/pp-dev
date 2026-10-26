// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getTabUserName, initUsersPanel } from '../../../src/client/users-panel.js';

/** PP-4597: the dev panel's "Users" popover. */

function makePanel(): HTMLElement {
  const $panel = document.createElement('div');

  $panel.className = 'pp-dev-info-namespace pp-dev-info';
  $panel.innerHTML = '<button class="pp-dev-info__users-btn"></button>';
  document.body.appendChild($panel);

  return $panel;
}

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const usersResponse = {
  available: true,
  defaultUser: 'viewer',
  users: [
    {
      name: 'viewer',
      kind: 'token',
      miUser: { id: 42, username: 'viewer@example.com' },
      origin: 'http://viewer.localhost:3000',
    },
    {
      name: 'qa',
      kind: 'session',
      state: 'expired',
      origin: 'http://qa.localhost:3000',
      loginUrl: 'http://qa.localhost:3000/login',
    },
  ],
};

describe('getTabUserName', () => {
  it.each([
    ['viewer.localhost', 'viewer'],
    ['localhost', undefined],
    ['127.0.0.1', undefined],
    ['a.b.localhost', undefined],
  ])('reads %s as %s', (hostname, name) => {
    expect(getTabUserName(hostname)).toBe(name);
  });
});

describe('initUsersPanel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    fetchMock = vi.fn(async () => json(200, usersResponse));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function openPopover() {
    const $panel = makePanel();

    initUsersPanel($panel);
    $panel.querySelector<HTMLButtonElement>('.pp-dev-info__users-btn')!.click();
    await flush();

    return $panel;
  }

  it('lists you and the saved users, with the default checked', async () => {
    const $panel = await openPopover();
    const names = [...$panel.querySelectorAll('.pp-dev-info__users-name')].map((el) => el.firstChild?.textContent);
    const checked = $panel.querySelector<HTMLInputElement>('.pp-dev-info__users-default:checked');

    expect(names).toEqual(['You', 'viewer', 'qa']);
    expect(checked?.value).toBe('viewer');
    expect($panel.textContent).toContain('viewer@example.com · API token');
    expect($panel.textContent).toContain('session expired');
  });

  it('says the main host works as the default user', async () => {
    const $panel = await openPopover();

    expect($panel.querySelector('.pp-dev-info__users-tab strong')!.textContent).toBe('viewer');
    expect($panel.querySelector('.pp-dev-info__users-row.is-current')!.getAttribute('data-user')).toBe('viewer');
    expect($panel.querySelector('.pp-dev-info__users-badge')!.closest('[data-user]')!.getAttribute('data-user')).toBe(
      'viewer',
    );
  });

  it("opens with the list loaded with the panel, before the popover's own request answers", async () => {
    const $panel = makePanel();

    initUsersPanel($panel);
    await flush();
    // The popover's own request never answers.
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    $panel.querySelector<HTMLButtonElement>('.pp-dev-info__users-btn')!.click();

    expect($panel.querySelectorAll('.pp-dev-info__users-row')).toHaveLength(3);
    expect($panel.querySelector('.pp-dev-info__users-tab strong')!.textContent).toBe('viewer');
  });

  it("marks this tab's user apart from localhost's default on a user's tab", async () => {
    const { jsdom } = globalThis as unknown as { jsdom: { reconfigure(opts: { url: string }): void } };

    jsdom.reconfigure({ url: 'http://qa.localhost:3000/' });

    try {
      const $panel = await openPopover();
      const $badge = $panel.querySelector('.pp-dev-info__users-badge')!;

      expect($panel.querySelectorAll('.pp-dev-info__users-badge')).toHaveLength(1);
      expect($badge.closest('[data-user]')!.getAttribute('data-user')).toBe('qa');
      expect($panel.querySelector<HTMLInputElement>('.pp-dev-info__users-default:checked')!.value).toBe('viewer');
    } finally {
      jsdom.reconfigure({ url: 'http://localhost:3000/' });
    }
  });

  it("offers to open the main host as you on a user's tab only while you are the default", async () => {
    const { jsdom } = globalThis as unknown as { jsdom: { reconfigure(opts: { url: string }): void } };

    jsdom.reconfigure({ url: 'http://qa.localhost:3000/' });

    try {
      const $withDefault = await openPopover();

      // localhost works as viewer now: viewer's own row opens it as viewer.
      expect($withDefault.querySelector('[data-focus-key=":open"]')).toBeNull();

      document.body.innerHTML = '';
      fetchMock.mockImplementation(async () => json(200, { ...usersResponse, defaultUser: null }));

      const $withoutDefault = await openPopover();

      expect($withoutDefault.querySelector('[data-focus-key=":open"]')).not.toBeNull();
    } finally {
      jsdom.reconfigure({ url: 'http://localhost:3000/' });
    }
  });

  it('says an IP address works as you, whatever the default user', async () => {
    const { jsdom } = globalThis as unknown as { jsdom: { reconfigure(opts: { url: string }): void } };

    jsdom.reconfigure({ url: 'http://127.0.0.1:3000/' });

    try {
      const $panel = await openPopover();

      expect($panel.querySelector('.pp-dev-info__users-tab strong')!.textContent).toBe('you');
      expect($panel.querySelector('.pp-dev-info__users-row.is-current')!.getAttribute('data-user')).toBeNull();
    } finally {
      jsdom.reconfigure({ url: 'http://localhost:3000/' });
    }
  });

  it('offers to log in again only to a session user that needs it, and not as the default', async () => {
    const $panel = await openPopover();
    const $qa = $panel.querySelector('[data-user="qa"]')!;
    const $viewer = $panel.querySelector('[data-user="viewer"]')!;

    expect($qa.querySelector('.pp-dev-info__users-action--accent')?.textContent).toBe('Log in');
    expect($qa.querySelector<HTMLInputElement>('.pp-dev-info__users-default')!.disabled).toBe(true);
    expect($viewer.querySelector('.pp-dev-info__users-action--accent')).toBeNull();
  });

  it('marks a token user MI turned down, and keeps it from being the default', async () => {
    fetchMock.mockImplementation(async () =>
      json(200, {
        ...usersResponse,
        defaultUser: null,
        users: [{ name: 'old', kind: 'token', state: 'expired', origin: 'http://old.localhost:3000' }],
      }),
    );

    const $panel = await openPopover();
    const $old = $panel.querySelector('[data-user="old"]')!;

    expect($old.textContent).toContain('API token turned down by MI');
    expect($old.classList.contains('needs-login')).toBe(true);
    expect($old.querySelector<HTMLInputElement>('.pp-dev-info__users-default')!.disabled).toBe(true);
    expect($old.querySelector('.pp-dev-info__users-action--accent')).toBeNull();
  });

  it('adds a token user', async () => {
    const $panel = await openPopover();

    $panel.querySelector<HTMLInputElement>('.pp-dev-info__users-name-input')!.value = 'admin';
    $panel.querySelector<HTMLInputElement>('.pp-dev-info__users-token')!.value = 'admin-token';
    fetchMock.mockResolvedValueOnce(json(201, { user: { name: 'admin', kind: 'token', origin: 'x' } }));
    $panel.querySelector<HTMLFormElement>('.pp-dev-info__users-add')!.requestSubmit();
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(
      '/@api/users',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'admin', token: 'admin-token' }) }),
    );
  });

  it('adds a session user and opens its login page', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const $panel = await openPopover();

    $panel.querySelector<HTMLButtonElement>('[data-kind="session"]')!.click();
    expect($panel.querySelector<HTMLInputElement>('.pp-dev-info__users-token')!.hidden).toBe(true);

    $panel.querySelector<HTMLInputElement>('.pp-dev-info__users-name-input')!.value = 'qa2';
    fetchMock.mockResolvedValueOnce(
      json(201, { user: { name: 'qa2', kind: 'session', origin: 'o', loginUrl: 'http://qa2.localhost:3000/login' } }),
    );
    $panel.querySelector<HTMLFormElement>('.pp-dev-info__users-add')!.requestSubmit();
    await flush();
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(
      '/@api/users',
      expect.objectContaining({ body: JSON.stringify({ name: 'qa2', kind: 'session' }) }),
    );
    expect(openSpy).toHaveBeenCalledWith('http://qa2.localhost:3000/login', '_blank');
  });

  it("shows the API's error", async () => {
    const $panel = await openPopover();

    fetchMock.mockResolvedValueOnce(json(409, { error: 'A user named "viewer" already exists' }));
    $panel.querySelector<HTMLFormElement>('.pp-dev-info__users-add')!.requestSubmit();
    await flush();
    await flush();

    const $error = $panel.querySelector<HTMLElement>('.pp-dev-info__users-error')!;

    expect($error.hidden).toBe(false);
    expect($error.textContent).toBe('A user named "viewer" already exists');
  });

  it('switches the default user', async () => {
    const $panel = await openPopover();
    const $you = $panel.querySelector<HTMLInputElement>('.pp-dev-info__users-default[value=""]')!;

    $you.checked = true;
    $you.dispatchEvent(new Event('change'));
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(
      '/@api/users/default',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ name: null }) }),
    );
  });

  describe('refreshing while open', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('leaves the list, and the keyboard focus, alone when nothing changed', async () => {
      const $panel = await openPopover();
      const $open = $panel.querySelector<HTMLButtonElement>('[data-focus-key="viewer:open"]')!;

      $open.focus();
      vi.advanceTimersByTime(3000);
      await flush();

      expect($panel.querySelector('[data-focus-key="viewer:open"]')).toBe($open);
      expect(document.activeElement).toBe($open);
    });

    it("puts the focus back on the same user's control when the list changes", async () => {
      const $panel = await openPopover();

      $panel.querySelector<HTMLButtonElement>('[data-focus-key="qa:remove"]')!.focus();
      fetchMock.mockImplementation(async () =>
        json(200, { ...usersResponse, users: [...usersResponse.users].reverse() }),
      );
      vi.advanceTimersByTime(3000);
      await flush();

      expect((document.activeElement as HTMLElement).dataset.focusKey).toBe('qa:remove');
    });
  });

  it('removes a user', async () => {
    const $panel = await openPopover();

    $panel.querySelector<HTMLButtonElement>('[data-remove="viewer"]')!.click();
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/@api/users/viewer', expect.objectContaining({ method: 'DELETE' }));
  });

  it('explains when users are not available', async () => {
    fetchMock.mockImplementation(async () => json(200, { ...usersResponse, available: false }));

    const $panel = await openPopover();

    expect($panel.querySelector<HTMLElement>('.pp-dev-info__users-add')!.hidden).toBe(true);
    expect($panel.querySelector('.pp-dev-info__users-unavailable')!.textContent).toContain('API token');
  });
});
