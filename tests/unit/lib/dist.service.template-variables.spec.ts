import { describe, it, expect, vi, afterEach } from 'vitest';

// Only `fs.promises.readFile` is intercepted (and only for the __template_variables.json
// path); everything else falls through to the real implementation so DistService's own
// meta-file bookkeeping (constructor's `syncMeta()`) keeps working against real fs, matching
// the partial-mock pattern used in dist.service.next.spec.ts.
const actualReadFile = vi.hoisted(() => ({ fn: null as unknown as (...args: any[]) => Promise<any> }));

vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();

  actualReadFile.fn = actual.promises.readFile.bind(actual.promises);

  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn((...args: any[]) => actualReadFile.fn(...args)),
    },
  };
});

const { DistService, TEMPLATE_VARIABLES_FILE_NAME } = await import('../../../src/lib/dist.service.js');
const fsModule = await import('fs');

function passthroughOtherPaths(filePath: unknown, ...rest: any[]) {
  return actualReadFile.fn(filePath, ...rest);
}

describe('DistService#readPublicTemplateVariablesFile', () => {
  afterEach(() => {
    vi.mocked(fsModule.promises.readFile).mockImplementation(passthroughOtherPaths);
  });

  it('returns null when public/__template_variables.json is missing', async () => {
    vi.mocked(fsModule.promises.readFile).mockImplementation((filePath: unknown, ...rest: any[]) => {
      if (String(filePath).endsWith(TEMPLATE_VARIABLES_FILE_NAME)) {
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      }

      return passthroughOtherPaths(filePath, ...rest);
    });

    const result = await new DistService('test-app').readPublicTemplateVariablesFile();

    expect(result).toBeNull();
  });

  it('returns the raw file content when present', async () => {
    const content = Buffer.from(JSON.stringify({ tags: [{ name: 'greeting', default_value: 'hello' }] }));

    vi.mocked(fsModule.promises.readFile).mockImplementation((filePath: unknown, ...rest: any[]) => {
      if (String(filePath).endsWith(TEMPLATE_VARIABLES_FILE_NAME)) {
        return Promise.resolve(content);
      }

      return passthroughOtherPaths(filePath, ...rest);
    });

    const result = await new DistService('test-app').readPublicTemplateVariablesFile();

    expect(result).toEqual(content);
  });
});
