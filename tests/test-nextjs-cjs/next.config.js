const { withPPDev } = require('@metricinsights/pp-dev');

// /** @type {import('next').NextConfig} */
// const nextConfig = withPPDev({
//   output: 'export',
//   cleanDistDir: true,
//   reactStrictMode: true,
//   distDir: 'dist',
//   images: {
//     unoptimized: true,
//   },
//   assetPrefix: '/pt/next-with-template',
//   basePath: '/p/next-with-template',
//   experimental: {
//     esmExternals: true
//   }
// });
const nextConfig = withPPDev({
  output: 'export',
  cleanDistDir: true,
  reactStrictMode: true,
  distDir: 'dist',
  images: {
    unoptimized: true,
  },
  // assetPrefix: '/pt/test-nextjs-cjs',
  // basePath: '/pl/test-nextjs-cjs',
});

module.exports = nextConfig;
