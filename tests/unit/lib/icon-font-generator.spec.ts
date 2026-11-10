import { describe, it, expect } from 'vitest';
import { loadSvgToFont, SvgToFontMissingError } from '../../../src/lib/icon-font-generator.js';

/**
 * `svgtofont` is an optional peer dependency, so a project that never generates icon fonts does not
 * install it (nor the `glob`/`minimatch` versions its dependencies ask for). The command has to say
 * what to install instead of failing with Node's ERR_MODULE_NOT_FOUND.
 */
describe('loadSvgToFont', () => {
  const notFound = (message: string, code = 'ERR_MODULE_NOT_FOUND') => Object.assign(new Error(message), { code });

  it('loads svgtofont when it is installed', async () => {
    expect(await loadSvgToFont()).toBeTypeOf('function');
  });

  it('tells how to install svgtofont when the package is missing', async () => {
    const cause = notFound(
      `Cannot find package 'svgtofont' imported from /app/node_modules/@metricinsights/pp-dev/dist/esm/cli.js`,
    );

    const error = await loadSvgToFont(() => Promise.reject(cause)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SvgToFontMissingError);
    expect((error as Error).message).toContain('npm install --save-dev svgtofont');
    expect((error as Error).cause).toBe(cause);
  });

  it('recognises the CommonJS form of the error too', async () => {
    const cause = notFound(`Cannot find module 'svgtofont'\nRequire stack:\n- /app/x.js`, 'MODULE_NOT_FOUND');

    await expect(loadSvgToFont(() => Promise.reject(cause))).rejects.toBeInstanceOf(SvgToFontMissingError);
  });

  it('passes on a missing package that svgtofont itself depends on', async () => {
    const cause = notFound(`Cannot find package 'svg2ttf' imported from /app/node_modules/svgtofont/lib/index.js`);

    await expect(loadSvgToFont(() => Promise.reject(cause))).rejects.toBe(cause);
  });

  it('passes on any other failure to load svgtofont', async () => {
    const cause = new SyntaxError('Unexpected token');

    await expect(loadSvgToFont(() => Promise.reject(cause))).rejects.toBe(cause);
  });
});
