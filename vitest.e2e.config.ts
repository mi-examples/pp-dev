import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.spec.ts'],
    pool: 'forks',
    // One file at a time: the suites edit the same fixture configs, and share mock-mi's port.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 90_000,
    reporter: ['verbose'],
  },
});
