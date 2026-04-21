import { PPDevConfig } from '@metricinsights/pp-dev';

const ppDevConfig: PPDevConfig = {
  backendBaseURL: 'https://stg7x.metricinsights.com',
  appId: 937,
  miHudLess: true,
  integrateMiTopBar: true,
  v7Features: true,
  templateLess: false,
  disableSSLValidation: true,
};

export default ppDevConfig;
