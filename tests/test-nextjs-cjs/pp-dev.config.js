/**
 * @type {import('@metricinsights/pp-dev').PPDevConfig}
 */
const ppDevConfig = {
  mi: {
    url: 'https://stg7x.metricinsights.com',
    mode: 'standalone',
    apiVersion: 7,
  },
  app: {
    id: 733,
    type: 'template',
  },
  proxy: {
    tls: { allowSelfSigned: true },
  },
};

module.exports = ppDevConfig;
