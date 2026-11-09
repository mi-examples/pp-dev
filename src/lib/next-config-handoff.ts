import type { PPDevConfig } from './pp-dev-config.js';

/**
 * What `withPPDev()` hands the CLI besides the config object it returns to Next.js.
 *
 * The config carries `ppDev` and the `ppDevWrapped` marker as non-enumerable properties, which
 * Next's own validation does not see. Next 15 and 16 copy them along (their `cloneObject` walks
 * every own key); Next 13 and 14 rebuild the config from `Object.keys()` and drop them, and the CLI
 * then saw neither the config nor the marker. So `withPPDev()` also records them here, on
 * `globalThis` under a shared symbol: the CLI and the `next.config` may load the package as
 * different module copies (ESM and CJS) in the one process that calls `loadConfig()`.
 */
export interface WithPPDevHandoff {
  ppDev: PPDevConfig;
  wrapped: true;
}

const HANDOFF_KEY = Symbol.for('@metricinsights/pp-dev:withPPDev');

type HandoffHolder = { [HANDOFF_KEY]?: WithPPDevHandoff };

export function recordWithPPDevHandoff(handoff: WithPPDevHandoff): void {
  (globalThis as HandoffHolder)[HANDOFF_KEY] = handoff;
}

/** The handoff of the last `withPPDev()` run in this process, if any. */
export function readWithPPDevHandoff(): WithPPDevHandoff | undefined {
  return (globalThis as HandoffHolder)[HANDOFF_KEY];
}

/** Before a `loadConfig()`, so what it reads afterwards is that load's. */
export function clearWithPPDevHandoff(): void {
  delete (globalThis as HandoffHolder)[HANDOFF_KEY];
}
