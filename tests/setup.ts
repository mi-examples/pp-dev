import { vi, beforeEach, afterEach } from 'vitest';

// Global test setup

// Reset all mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

// Clean up after each test
afterEach(() => {
  vi.restoreAllMocks();
});

// Mock console methods to reduce noise in tests (optional)
// Uncomment if you want cleaner test output
// vi.spyOn(console, 'log').mockImplementation(() => {});
// vi.spyOn(console, 'info').mockImplementation(() => {});
// vi.spyOn(console, 'warn').mockImplementation(() => {});

// Global test utilities
export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to create temporary directories for tests
export const createTempDir = async (prefix: string = 'pp-dev-test') => {
  const { mkdtemp } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const { join } = await import('path');

  return mkdtemp(join(tmpdir(), `${prefix}-`));
};

// Helper to clean up temporary directories
export const cleanupTempDir = async (dir: string) => {
  const { rm } = await import('fs/promises');
  
  await rm(dir, { recursive: true, force: true });
};
