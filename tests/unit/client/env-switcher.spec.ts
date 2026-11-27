// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { initEnvSwitcher } from '../../../src/client/env-switcher.js';

/**
 * PP-4840 phase 4: the dev panel's MI environment switcher. With more than one environment in the
 * config the name becomes a list; a choice, once confirmed, asks the server to restart in it, and
 * every tab reloads once the server answers with the chosen environment.
 */

type Handler = (payload: any) => unknown;

const ENVIRONMENTS = {
  current: 'default',
  environments: [
    { name: 'default', hasUrl: true, protected: false },
    { name: 'stg70', hasUrl: true, protected: true },
    { name: 'nourl', hasUrl: false, protected: false },
  ],
};

const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

async function setup({
  environments = ENVIRONMENTS,
  confirmed = true,
  firstAnswer,
  pageEnv = '',
}: {
  environments?: typeof ENVIRONMENTS;
  confirmed?: boolean;
  /** The first ask's answer in place of `environments` (a rejection: the server restarting). */
  firstAnswer?: () => Promise<Response>;
  /** The environment's name in the page's markup; none for the default one. */
  pageEnv?: string;
} = {}) {
  document.body.innerHTML = `
    <div class="pp-dev-info__section pp-dev-info__env-section pp-dev-info__env-section--none">
      <span class="pp-dev-info__label">Environment:</span>
      <span class="pp-dev-info__value pp-dev-info__env">${pageEnv}</span>
    </div>`;

  const handlers = new Map<string, Handler[]>();
  const hot = {
    on: (event: string, cb: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), cb]),
    send: vi.fn(),
  };
  const fetch = vi.fn(async () => json(environments));

  if (firstAnswer) {
    fetch.mockImplementationOnce(firstAnswer);
  }
  const deps = {
    infoPopup: vi.fn(),
    confirmModal: vi.fn().mockResolvedValue(confirmed),
    reload: vi.fn(),
    fetch: fetch as unknown as typeof window.fetch,
  };
  const $section = document.querySelector<HTMLElement>('.pp-dev-info__env-section')!;

  await initEnvSwitcher(hot as never, $section, deps);

  const emit = (event: string, payload: unknown) => (handlers.get(event) ?? []).forEach((cb) => cb(payload));
  const choose = async (name: string) => {
    const $select = document.querySelector<HTMLSelectElement>('.pp-dev-info__env-select')!;

    $select.value = name;
    $select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(deps.confirmModal).toHaveBeenCalled());
    await Promise.resolve();
  };

  return { hot, fetch, deps, $section, emit, choose };
}

describe('the MI environment switcher', () => {
  afterEach(() => {
    vi.useRealTimers();
    window.sessionStorage.clear();
  });

  it('lists the environments in place of the name, those without a URL not to be chosen', async () => {
    const { $section } = await setup();
    const $select = document.querySelector<HTMLSelectElement>('.pp-dev-info__env-select')!;

    expect($section.classList.contains('pp-dev-info__env-section--none')).toBe(false);
    expect([...$select.options].map((o) => [o.value, o.textContent, o.disabled])).toEqual([
      ['default', 'default', false],
      ['stg70', 'stg70 (protected)', false],
      ['nourl', 'nourl (no URL)', true],
    ]);
    expect($select.value).toBe('default');
  });

  it('leaves the name as it was with a single environment', async () => {
    const { $section } = await setup({
      environments: { current: 'default', environments: [{ name: 'default', hasUrl: true, protected: false }] },
    });

    expect(document.querySelector('.pp-dev-info__env-select')).toBeNull();
    expect($section.classList.contains('pp-dev-info__env-section--none')).toBe(true);
  });

  it('asks the server to switch once the choice is confirmed', async () => {
    const { hot, deps, choose } = await setup();

    await choose('stg70');

    expect(deps.confirmModal).toHaveBeenCalledWith(expect.objectContaining({ confirmText: 'Switch to stg70' }));
    expect(hot.send).toHaveBeenCalledWith('env:switch', { name: 'stg70' });
  });

  it('switches nothing when the choice is cancelled', async () => {
    const { hot, choose } = await setup({ confirmed: false });

    await choose('stg70');

    expect(hot.send).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLSelectElement>('.pp-dev-info__env-select')!.value).toBe('default');
  });

  it('reloads once the restarted server answers with the chosen environment', async () => {
    vi.useFakeTimers();

    const { fetch, deps, emit } = await setup();

    emit('env:switching', { name: 'stg70' });
    // The server restarting: no answer, then still the old one, then the new one.
    fetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ ...ENVIRONMENTS, current: 'default' }))
      .mockResolvedValueOnce(json({ ...ENVIRONMENTS, current: 'stg70' }));

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.reload).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it('shows why a switch failed and keeps the environment it had', async () => {
    vi.useFakeTimers();

    const { fetch, deps, emit } = await setup();
    const $select = document.querySelector<HTMLSelectElement>('.pp-dev-info__env-select')!;

    emit('env:switching', { name: 'stg70' });
    emit('env:switch:failed', { name: 'stg70', error: 'the config refused it' });

    expect($select.value).toBe('default');
    expect($select.disabled).toBe(false);
    expect(deps.infoPopup).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'danger', content: expect.stringContaining('the config refused it') }),
    );

    // No more polling.
    const calls = fetch.mock.calls.length;

    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch.mock.calls.length).toBe(calls);
  });
  it('offers no list where the server cannot restart (plain vite with the plugin)', async () => {
    await setup({ environments: { ...ENVIRONMENTS, canSwitch: false } as typeof ENVIRONMENTS });

    expect(document.querySelector('.pp-dev-info__env-select')).toBeNull();
  });

  // A tab whose connection was down during a switch was never told of it.
  it('reloads after a reconnect when the server works with another environment now', async () => {
    const { fetch, deps, emit } = await setup();

    emit('vite:ws:disconnect', {});
    fetch.mockResolvedValueOnce(json({ ...ENVIRONMENTS, current: 'stg70' }));
    emit('vite:ws:connect', {});

    await vi.waitFor(() => expect(deps.reload).toHaveBeenCalledTimes(1));
  });

  it('stays after a reconnect to the same environment', async () => {
    const { fetch, deps, emit } = await setup();
    const calls = fetch.mock.calls.length;

    emit('vite:ws:disconnect', {});
    emit('vite:ws:connect', {});

    await vi.waitFor(() => expect(fetch.mock.calls.length).toBe(calls + 1));
    await Promise.resolve();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  // The first ask during a restart failed, and nothing asked again: no list for good, and the old
  // environment shown after the server came back in another.
  it('gets its list once the server is back when its first ask failed', async () => {
    const { emit } = await setup({ firstAnswer: () => Promise.reject(new TypeError('Failed to fetch')) });

    expect(document.querySelector('.pp-dev-info__env-select')).toBeNull();

    emit('vite:ws:disconnect', {});
    emit('vite:ws:connect', {});

    await vi.waitFor(() => expect(document.querySelector('.pp-dev-info__env-select')).not.toBeNull());
    expect(document.querySelector<HTMLSelectElement>('.pp-dev-info__env-select')!.value).toBe('default');
  });

  it('reloads when its first ask failed and the server came back in another environment', async () => {
    const { fetch, deps } = await setup({
      pageEnv: 'stg70',
      firstAnswer: () => Promise.reject(new TypeError('Failed to fetch')),
    });

    fetch.mockResolvedValueOnce(json({ ...ENVIRONMENTS, current: 'default' }));
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(() => expect(deps.reload).toHaveBeenCalledTimes(1));
  });

  // A failure while a poll awaited its answer: the poll went on after it, and could time out later.
  it('drops a poll that was awaiting its answer when the switch failed', async () => {
    vi.useFakeTimers();

    const { fetch, deps, emit } = await setup();
    let answer!: (response: Response) => void;

    fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
    emit('env:switching', { name: 'stg70' });
    await vi.advanceTimersByTimeAsync(1000);

    emit('env:switch:failed', { name: 'stg70', error: 'the config refused it' });
    answer(json({ ...ENVIRONMENTS, current: 'default' }));
    await vi.advanceTimersByTimeAsync(0);

    const calls = fetch.mock.calls.length;

    await vi.advanceTimersByTimeAsync(200_000);
    expect(fetch.mock.calls.length).toBe(calls);
    expect(deps.infoPopup).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Environment switch', type: 'danger' }),
    );
  });

  // The server started again in the old environment after the restart failed: the one that would
  // have told the tab is gone, and the tab waited until its timeout.
  it('shows the failure the server started again tells, once, and stops waiting', async () => {
    vi.useFakeTimers();

    const { fetch, deps, emit } = await setup();
    const $select = document.querySelector<HTMLSelectElement>('.pp-dev-info__env-select')!;

    emit('env:switching', { name: 'stg70' });
    fetch.mockResolvedValueOnce(
      json({ ...ENVIRONMENTS, current: 'default', failedSwitch: { name: 'stg70', error: 'it did not start' } }),
    );
    await vi.advanceTimersByTimeAsync(1000);

    expect($select.value).toBe('default');
    expect($select.disabled).toBe(false);
    expect(deps.infoPopup).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'danger', content: expect.stringContaining('it did not start') }),
    );

    // The same failure over the WebSocket afterwards (`pp-dev` kept the server): not twice.
    const popups = deps.infoPopup.mock.calls.length;

    emit('env:switch:failed', { name: 'stg70', error: 'it did not start' });
    expect(deps.infoPopup.mock.calls.length).toBe(popups);

    const calls = fetch.mock.calls.length;

    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch.mock.calls.length).toBe(calls);
    expect(deps.reload).not.toHaveBeenCalled();
  });

  // The page was served before a switch it missed, the first answer after it: the tab took the new
  // environment as its own, and a Sync from the old page went to it.
  it('reloads a page served in another environment than the server answers in, once', async () => {
    const first = await setup({ pageEnv: 'stg70' });

    expect(first.deps.reload).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.pp-dev-info__env-select')).toBeNull();

    // Should the page's name and the server's not agree for good: no second reload, the list.
    const second = await setup({ pageEnv: 'stg70' });

    expect(second.deps.reload).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLSelectElement>('.pp-dev-info__env-select')!.value).toBe('default');
  });

  // A config change restarts the server in the same environment: the list kept the old choices.
  it('makes the list again when the server comes back with other choices, and the name without any', async () => {
    const { fetch, emit, $section } = await setup();
    const options = () =>
      [...document.querySelectorAll<HTMLOptionElement>('.pp-dev-info__env-select option')].map((o) => o.textContent);

    emit('vite:ws:disconnect', {});
    fetch.mockResolvedValueOnce(
      json({
        current: 'default',
        environments: [
          { name: 'default', hasUrl: true, protected: false },
          { name: 'stg70', hasUrl: false, protected: false },
          { name: 'prod', hasUrl: true, protected: true },
        ],
      }),
    );
    emit('vite:ws:connect', {});

    await vi.waitFor(() => expect(options()).toEqual(['default', 'stg70 (no URL)', 'prod (protected)']));
    expect(document.querySelectorAll('.pp-dev-info__env-select')).toHaveLength(1);

    emit('vite:ws:disconnect', {});
    fetch.mockResolvedValueOnce(
      json({ current: 'default', environments: [{ name: 'default', hasUrl: true, protected: false }] }),
    );
    emit('vite:ws:connect', {});

    await vi.waitFor(() => expect(document.querySelector('.pp-dev-info__env-select')).toBeNull());
    expect(document.querySelector('.pp-dev-info__env')).not.toBeNull();
    expect($section.classList.contains('pp-dev-info__env-section--none')).toBe(true);
  });
});
