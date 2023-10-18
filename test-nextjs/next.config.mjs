import { withPPDev } from '@metricinsights/pp-dev';

/** @type {import('next').NextConfig} */
const nextConfig = withPPDev({
  output: 'export',
  cleanDistDir: true,
  reactStrictMode: true,
  distDir: 'dist',
  images: {
    unoptimized: true,
  },
});

export default nextConfig;
