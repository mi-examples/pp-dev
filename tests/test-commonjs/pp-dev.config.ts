import { defineConfig } from '@metricinsights/pp-dev';

export default defineConfig({
  mi: {
    url: 'https://stg7x.metricinsights.com',
    mode: 'standalone',
    include: 'top-bar',
    apiVersion: 7,
  },
  app: {
    id: 937,
    type: 'template',
  },
  proxy: {
    tls: { allowSelfSigned: true },
  },
});
