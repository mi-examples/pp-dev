import { vi, beforeEach, afterEach } from 'vitest';

// Global test setup: every spec starts with cleared mocks and leaves none behind.

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});
