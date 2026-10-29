import { globSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const UNIT_SPECS = 'tests/unit/**/*.spec.ts';

// Without isolation a worker keeps the modules earlier files imported, so a `vi.mock` in a later file
// doesn't reach them. Specs that mock or reset modules keep running isolated; the rest share workers.
const moduleMockingSpecs = globSync(UNIT_SPECS)
  .map((file) => file.replaceAll('\\', '/'))
  .filter((file) => /\bvi\.(?:mock|doMock|resetModules)\(/.test(readFileSync(file, 'utf-8')));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage/unit',
      include: ['src/**/*.ts'],
      exclude: ['src/client/**', 'src/**/*.d.ts', 'src/banner/**'],
    },
    setupFiles: ['tests/setup.ts'],
    testTimeout: 10000,
    // `include` and `exclude` are set per project only: `extends` adds the root ones to each project's.
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: [UNIT_SPECS], exclude: moduleMockingSpecs, isolate: false },
      },
      {
        extends: true,
        test: { name: 'unit-isolated', include: moduleMockingSpecs },
      },
    ],
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
