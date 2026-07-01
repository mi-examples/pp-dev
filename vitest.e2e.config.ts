import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.spec.ts'],
    pool: 'forks',
    singleFork: true,
    testTimeout: 60_000,
    hookTimeout: 90_000,
    reporter: ['verbose'],
  },
});
