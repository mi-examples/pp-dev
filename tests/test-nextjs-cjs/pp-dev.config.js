/**
 * @type {import('@metricinsights/pp-dev').PPDevConfig}
 */
const ppDevConfig = {
  backendBaseURL: 'https://stg7x.metricinsights.com',
  portalPageId: 733,
  v7Features: true,
  templateLess: false,
  miHudLess: true,
  disableSSLValidation: true,
};

module.exports = ppDevConfig;
