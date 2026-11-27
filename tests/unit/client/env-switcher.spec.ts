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

async function setup({ environments = ENVIRONMENTS, confirmed = true } = {}) {
  document.body.innerHTML = `
    <div class="pp-dev-info__section pp-dev-info__env-section pp-dev-info__env-section--none">
      <span class="pp-dev-info__label">Environment:</span>
      <span class="pp-dev-info__value pp-dev-info__env"></span>
    </div>`;

  const handlers = new Map<string, Handler[]>();
  const hot = {
    on: (event: string, cb: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), cb]),
    send: vi.fn(),
  };
  const fetch = vi.fn(async () => json(environments));
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
});
