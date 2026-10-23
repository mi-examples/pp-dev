/**
 * The dev panel's "Users" popover (PP-4597): the user of this tab, the saved users (open as, log
 * in, make default, remove) and adding a user by API token or by username + password. Each user
 * works on its own host, `<name>.localhost:<port>`; see src/lib/user-registry.ts.
 */

interface PublicUser {
  name: string;
  kind: 'token' | 'session';
  state?: 'pending' | 'active' | 'expired';
  miUser?: { id: number; username: string };
  origin: string;
  loginUrl?: string;
}

interface UsersResponse {
  available: boolean;
  users: PublicUser[];
  defaultUser: string | null;
}

const USERS_API = '/@api/users';
const REFRESH_INTERVAL = 3000;

const USER_HOST_REGEXP = /^([a-z](?:[a-z0-9-]*[a-z0-9])?)\.localhost$/;

const STATE_LABELS: Record<NonNullable<PublicUser['state']>, string> = {
  pending: 'not logged in yet',
  active: 'logged in',
  expired: 'session expired',
};

/** The saved user this tab belongs to, from its host; `undefined` on the main host. */
export function getTabUserName(hostname = window.location.hostname): string | undefined {
  return USER_HOST_REGEXP.exec(hostname)?.[1];
}

/** Users need `*.localhost` hosts, which only exist when the dev server is opened on localhost. */
function isOnLocalhost(hostname = window.location.hostname): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost');
}

function mainOrigin(): string {
  const { protocol, port } = window.location;

  return `${protocol}//localhost${port ? `:${port}` : ''}`;
}

/** The current page on another origin, so "open as" keeps the page you are on. */
function samePageOn(origin: string): string {
  const { pathname, search, hash } = window.location;

  return `${origin}${pathname}${search}${hash}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function describeUser(user: PublicUser): string {
  const who = user.miUser?.username || (user.miUser ? `MI user ${user.miUser.id}` : '');
  const how =
    user.kind === 'token'
      ? user.state === 'expired'
        ? 'API token turned down by MI'
        : 'API token'
      : STATE_LABELS[user.state ?? 'pending'];

  return [who, how].filter(Boolean).join(' · ');
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();

    return body?.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

export interface UsersPanelHooks {
  onOpenChange?: (open: boolean) => void;
}

export function initUsersPanel($panel: HTMLElement, hooks?: UsersPanelHooks): void {
  const $btn = $panel.querySelector<HTMLButtonElement>('.pp-dev-info__users-btn');

  if (!$btn) {
    return;
  }

  const tabUser = getTabUserName();

  // On a saved user's host the button stands out (the name is in its tooltip and the popover, so a
  // long name doesn't widen the panel), so the tab is never mistaken for your own.
  if (tabUser) {
    $panel.classList.add('pp-dev-info--user-tab');
    $btn.title = `This tab works as ${tabUser}. Users…`;
    $btn.setAttribute('aria-label', `Users (this tab works as ${tabUser})`);
  }

  let $popover: HTMLDivElement | null = null;
  let refreshTimer: number | undefined;
  let addKind: PublicUser['kind'] = 'token';
  let data: UsersResponse | null = null;

  const onDocClick = (ev: MouseEvent) => {
    const target = ev.target as Node;

    if ($popover && !$popover.contains(target) && !$btn.contains(target)) {
      close();
    }
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      close();
    }
  };

  const close = () => {
    if (!$popover) {
      return;
    }

    window.clearInterval(refreshTimer);
    $popover.remove();
    $popover = null;
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    hooks?.onOpenChange?.(false);
  };

  const setError = (message: string) => {
    const $error = $popover?.querySelector<HTMLElement>('.pp-dev-info__users-error');

    if ($error) {
      $error.textContent = message;
      $error.hidden = !message;
    }
  };

  const request = async (method: string, path: string, body?: unknown): Promise<Response | null> => {
    try {
      const response = await fetch(path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if (!response.ok) {
        setError(await readError(response));

        return null;
      }

      setError('');

      return response;
    } catch {
      setError('pp-dev is not reachable');

      return null;
    }
  };

  const renderList = () => {
    const $list = $popover?.querySelector<HTMLElement>('.pp-dev-info__users-list');

    if (!$popover || !$list || !data) {
      return;
    }

    const defaultUser = data.defaultUser;
    // The main host works as the default user, a user's host as that user.
    const currentUser = tabUser ?? defaultUser ?? undefined;
    const $tab = $popover.querySelector<HTMLElement>('.pp-dev-info__users-tab strong');

    if ($tab) {
      $tab.textContent = currentUser ?? 'you';
    }

    const rows = [
      `<div class="pp-dev-info__users-row${currentUser ? '' : ' is-current'}">
        <input type="radio" name="pp-dev-default-user" class="pp-dev-info__users-default" value=""
          title="Make the main host (localhost) work as you" ${defaultUser ? '' : 'checked'} />
        <div class="pp-dev-info__users-who">
          <span class="pp-dev-info__users-name">You</span>
          <span class="pp-dev-info__users-meta">original user · the dev panel always works as you</span>
        </div>
        ${tabUser ? `<button type="button" class="pp-dev-info__users-action" data-open="${escapeHtml(mainOrigin())}" title="Open this page on the main host">Open</button>` : ''}
      </div>`,
      ...data.users.map((user) => {
        const canBeDefault = user.kind === 'token' ? user.state !== 'expired' : user.state === 'active';
        const needsLogin = user.kind === 'session' && user.state !== 'active';
        const needsAttention = needsLogin || user.state === 'expired';
        const name = escapeHtml(user.name);
        let defaultTitle = `Make the main host (localhost) work as ${name}`;

        if (!canBeDefault) {
          defaultTitle =
            user.kind === 'token' ? `MI turned down the API token of ${name}` : `${name} has to log in first`;
        }

        return `<div class="pp-dev-info__users-row${user.name === currentUser ? ' is-current' : ''}${
          needsAttention ? ' needs-login' : ''
        }" data-user="${name}">
          <input type="radio" name="pp-dev-default-user" class="pp-dev-info__users-default" value="${name}"
            title="${defaultTitle}"
            ${user.name === defaultUser ? 'checked' : ''} ${canBeDefault ? '' : 'disabled'} />
          <div class="pp-dev-info__users-who">
            <span class="pp-dev-info__users-name">${name}</span>
            <span class="pp-dev-info__users-meta">${escapeHtml(describeUser(user))}</span>
          </div>
          ${
            needsLogin && user.loginUrl
              ? `<button type="button" class="pp-dev-info__users-action pp-dev-info__users-action--accent" data-open="${escapeHtml(user.loginUrl)}" data-raw="true">Log in</button>`
              : ''
          }
          <button type="button" class="pp-dev-info__users-action" data-open="${escapeHtml(user.origin)}" title="Open this page as ${name}">Open</button>
          <button type="button" class="pp-dev-info__users-remove" data-remove="${name}" title="Remove ${name}" aria-label="Remove ${name}">×</button>
        </div>`;
      }),
    ];

    $list.innerHTML = rows.join('');

    $list.querySelectorAll<HTMLButtonElement>('[data-open]').forEach(($open) => {
      $open.addEventListener('click', (ev) => {
        ev.preventDefault();

        const target = $open.dataset.open!;

        window.open($open.dataset.raw ? target : samePageOn(target), '_blank');
      });
    });

    $list.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(($remove) => {
      $remove.addEventListener('click', async (ev) => {
        ev.preventDefault();

        if (await request('DELETE', `${USERS_API}/${encodeURIComponent($remove.dataset.remove!)}`)) {
          await refresh();
        }
      });
    });

    $list.querySelectorAll<HTMLInputElement>('.pp-dev-info__users-default').forEach(($radio) => {
      $radio.addEventListener('change', async () => {
        await request('PUT', `${USERS_API}/default`, { name: $radio.value || null });
        await refresh();
      });
    });
  };

  const renderAvailability = () => {
    if (!$popover || !data) {
      return;
    }

    const $form = $popover.querySelector<HTMLElement>('.pp-dev-info__users-add');
    const $unavailable = $popover.querySelector<HTMLElement>('.pp-dev-info__users-unavailable');
    let reason = '';

    if (!isOnLocalhost()) {
      reason = 'Users open on <name>.localhost hosts: open the dev server on localhost to use them.';
    } else if (!data.available) {
      reason = 'Adding users needs your own API token: set mi.token or MI_ACCESS_TOKEN.';
    }

    if ($form) {
      $form.hidden = Boolean(reason);
    }

    if ($unavailable) {
      $unavailable.textContent = reason;
      $unavailable.hidden = !reason;
    }
  };

  const refresh = async () => {
    try {
      const response = await fetch(USERS_API);

      if (!response.ok) {
        return;
      }

      data = (await response.json()) as UsersResponse;
      renderList();
      renderAvailability();
    } catch {
      // The next refresh tries again.
    }
  };

  const renderKind = () => {
    if (!$popover) {
      return;
    }

    $popover.querySelectorAll<HTMLButtonElement>('.pp-dev-info__users-kind').forEach(($kind) => {
      const active = $kind.dataset.kind === addKind;

      $kind.classList.toggle('active', active);
      $kind.setAttribute('aria-pressed', String(active));
    });

    const $token = $popover.querySelector<HTMLInputElement>('.pp-dev-info__users-token');
    const $submit = $popover.querySelector<HTMLButtonElement>('.pp-dev-info__users-submit');
    const $kindHint = $popover.querySelector<HTMLElement>('.pp-dev-info__users-kind-hint');

    if ($token) {
      $token.hidden = addKind !== 'token';
    }

    if ($submit) {
      $submit.textContent = addKind === 'token' ? 'Add user' : 'Add and log in…';
    }

    if ($kindHint) {
      $kindHint.textContent =
        addKind === 'token'
          ? 'Checked with MI before the user is added. SSO users can only be added this way.'
          : "Opens MI's login page on the user's own host. pp-dev never sees the password.";
    }
  };

  const submit = async () => {
    if (!$popover) {
      return;
    }

    const $name = $popover.querySelector<HTMLInputElement>('.pp-dev-info__users-name-input')!;
    const $token = $popover.querySelector<HTMLInputElement>('.pp-dev-info__users-token')!;
    const $submit = $popover.querySelector<HTMLButtonElement>('.pp-dev-info__users-submit')!;
    const body =
      addKind === 'token'
        ? { name: $name.value.trim(), token: $token.value }
        : { name: $name.value.trim(), kind: 'session' };

    $submit.disabled = true;

    const response = await request('POST', USERS_API, body);

    $submit.disabled = false;

    if (!response) {
      return;
    }

    const { user } = (await response.json()) as { user: PublicUser };

    $name.value = '';
    $token.value = '';

    if (user.kind === 'session' && user.loginUrl) {
      window.open(user.loginUrl, '_blank');
    }

    await refresh();
  };

  const open = () => {
    $popover = document.createElement('div');
    $popover.classList.add('pp-dev-info__settings', 'pp-dev-info__users');
    $popover.innerHTML = `
      <div class="pp-dev-info__settings-title">Users</div>
      <div class="pp-dev-info__users-tab">
        This tab works as <strong>${escapeHtml(tabUser ?? 'you')}</strong>.
        <span>localhost works as the checked user; each user's own host as that user.</span>
      </div>
      <div class="pp-dev-info__users-list" role="radiogroup" aria-label="Default user"></div>
      <div class="pp-dev-info__users-unavailable" hidden></div>
      <form class="pp-dev-info__settings-group pp-dev-info__users-add" hidden>
        <span class="pp-dev-info__settings-label">Add user</span>
        <div class="pp-dev-info__theme-grid" role="group" aria-label="How the user logs in">
          <button type="button" class="pp-dev-info__theme-btn pp-dev-info__users-kind" data-kind="token">API token</button>
          <button type="button" class="pp-dev-info__theme-btn pp-dev-info__users-kind" data-kind="session">Username + password</button>
        </div>
        <input class="pp-dev-info__users-input pp-dev-info__users-name-input" placeholder="Name, e.g. viewer" maxlength="32"
          autocomplete="off" spellcheck="false" pattern="[a-z]([a-z0-9-]*[a-z0-9])?"
          title="Lowercase latin letters, digits and -, starting with a letter. The user opens on <name>.localhost." />
        <input class="pp-dev-info__users-input pp-dev-info__users-token" type="password" placeholder="API token" autocomplete="off" />
        <button type="submit" class="pp-dev-info__vars-btn pp-dev-info__users-submit">Add user</button>
        <div class="pp-dev-info__settings-hint pp-dev-info__users-kind-hint"></div>
      </form>
      <div class="pp-dev-info__users-error" role="alert" hidden></div>
      <div class="pp-dev-info__settings-hint">Each user opens on <code>&lt;name&gt;.localhost</code> and is kept until the dev server stops.</div>
    `;

    $popover.querySelectorAll<HTMLButtonElement>('.pp-dev-info__users-kind').forEach(($kind) => {
      $kind.addEventListener('click', (ev) => {
        ev.preventDefault();
        addKind = $kind.dataset.kind as PublicUser['kind'];
        renderKind();
      });
    });

    $popover.querySelector<HTMLFormElement>('.pp-dev-info__users-add')!.addEventListener('submit', (ev) => {
      ev.preventDefault();
      submit();
    });

    renderKind();
    $panel.appendChild($popover);
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    hooks?.onOpenChange?.(true);

    refresh();
    // Picks up logins and expired sessions while the popover is open.
    refreshTimer = window.setInterval(refresh, REFRESH_INTERVAL);
  };

  $btn.addEventListener('click', (ev) => {
    ev.preventDefault();

    if ($popover) {
      close();
    } else {
      open();
    }
  });
}
