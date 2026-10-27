import { createRequire } from 'node:module';

type JsdomModule = typeof import('jsdom');

let jsdom: JsdomModule | undefined;

/**
 * jsdom, loaded on first use.
 *
 * It takes about a second to load, and it is only needed to build a served page or normalize SVGs
 * after a build, not to read the config in next.config, print `--version` or start most commands.
 * It is CommonJS, so `require` loads it synchronously and its callers can stay synchronous.
 */
export function getJSDOM(): JsdomModule['JSDOM'] {
  jsdom ??= createRequire(import.meta.url)('jsdom') as JsdomModule;

  return jsdom.JSDOM;
}
