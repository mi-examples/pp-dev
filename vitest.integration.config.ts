import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.spec.ts'],
    exclude: ['tests/unit/**', 'tests/test-*/**', 'e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage/integration',
      include: ['src/**/*.ts'],
      exclude: [
        'src/client/**',
        'src/**/*.d.ts',
        'src/banner/**',
      ],
    },
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30000,
    pool: 'forks', // Better isolation for integration tests
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
