export * from './helpers/formatting.js';

import type { PPDevConfig } from './lib/pp-dev-config.js';

export function defineConfig(config: PPDevConfig): PPDevConfig {
  return config;
}
