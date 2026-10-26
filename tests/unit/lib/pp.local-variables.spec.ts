import { describe, it, expect, vi } from 'vitest';
import { MiAPI } from '../../../src/lib/pp.middleware.js';

/** The page variable values the dev server substitutes into the pages it serves, as last loaded from MI. */

function makeMi(tags: { name: string; value: string }[]) {
  const mi = new MiAPI('http://mi.example.com', { templateLess: false, appId: 7 });

  vi.spyOn(mi, 'getPageTemplate').mockResolvedValue('<html></html>' as never);
  vi.spyOn(mi.pageApi, 'get').mockResolvedValue({
    name: 'Sales',
    template: 'tpl',
    tags: JSON.stringify(tags),
  } as never);

  return mi;
}

describe('MiAPI.localPageVariables', () => {
  it('is null until the page variables are loaded', () => {
    expect(makeMi([]).localPageVariables).toBeNull();
  });

  it('holds the values loaded with the page data, and the reloaded ones after that', async () => {
    const mi = makeMi([{ name: 'Region', value: 'US' }]);

    await mi.getPageVariables(7, {});

    expect(mi.localPageVariables).toEqual([{ name: 'Region', value: 'US' }]);

    vi.spyOn(mi.pageApi, 'get').mockResolvedValue({
      name: 'Sales',
      template: 'tpl',
      tags: JSON.stringify([{ name: 'Region', value: 'EMEA' }]),
    } as never);
    await mi.reloadPageVariables();

    expect(mi.localPageVariables).toEqual([{ name: 'Region', value: 'EMEA' }]);
  });

  it('is null for a templateLess page', () => {
    expect(new MiAPI('http://mi.example.com', { templateLess: true }).localPageVariables).toBeNull();
  });
});
