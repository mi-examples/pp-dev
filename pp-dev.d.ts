import type { PPDevConfig, PPWatchConfig } from '.';

declare module 'pp-dev.config.ts' {
  const config: PPDevConfig;

  export default config;
}

declare module '.pp-dev.config.ts' {
  const config: PPDevConfig;

  export default config;
}

declare module 'pp-dev.config.js' {
  const config: PPDevConfig;

  export default config;
}

declare module '.pp-dev.config.js' {
  const config: PPDevConfig;

  export default config;
}

declare module 'pp-dev.config.json' {
  const config: PPDevConfig;

  export default config;
}

declare module '.pp-dev.config.json' {
  const config: PPDevConfig;

  export default config;
}

declare module '.pp-watch.config.ts' {
  const config: PPWatchConfig;

  export default config;
}

declare module '.pp-watch.config.js' {
  const config: PPWatchConfig;

  export default config;
}

declare module '.pp-watch.config.json' {
  const config: PPWatchConfig;

  export default config;
}

declare module '*.scss' {
  const content: Record<string, string>;
  export default content;
}
