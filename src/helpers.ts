export * from './helpers/formatting.js';

import type { PPDevConfig } from './plugin.js';

export function defineConfig(config: PPDevConfig): PPDevConfig {
  return config;
}
