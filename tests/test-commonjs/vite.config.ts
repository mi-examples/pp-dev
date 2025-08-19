import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig(() => {
  return {
    server: {
      // open: true,
    },
    resolve: {
      alias: {
        '@metricinsights/pp-dev': path.resolve(__dirname, '../dist/esm'),
        '@metricinsights/pp-dev/helpers': path.resolve(__dirname, '../dist/esm/helpers.js'),
      },
    },
  };
});
