# pp-dev Testing Guide

This document describes the comprehensive testing setup for the pp-dev package.

## Test Architecture

The testing suite is organized into three layers:

### 1. Unit Tests (`tests/unit/`)

Unit tests verify isolated functions and modules without external dependencies.

```
tests/unit/
├── config/
│   ├── config.loader.spec.ts      # Config file loading & caching
│   └── config.validation.spec.ts  # Config file name patterns
├── plugin/
│   └── plugin.normalize.spec.ts   # normalizeVitePPDevConfig function
├── lib/
│   ├── url.helper.spec.ts         # URL replacement utilities
│   └── color.helper.spec.ts       # Terminal color utilities
└── helpers/
    └── formatting.spec.ts         # Template literal helpers
```

**Run unit tests:**
```bash
npm run test:unit           # Run once
npm run test:unit:watch     # Watch mode
npm run test:unit:coverage  # With coverage report
```

### 2. Integration Tests (`tests/integration/`)

Integration tests verify middleware and server components working together.

```
tests/integration/
└── middleware/
    ├── pp-redirect.spec.ts       # PP redirect middleware
    ├── proxy-cache.spec.ts       # Proxy cache middleware
    └── rewrite-response.spec.ts  # Response rewriting middleware
```

**Run integration tests:**
```bash
npm run test:integration        # Run once
npm run test:integration:watch  # Watch mode
```

### 3. E2E Tests (`e2e/`)

End-to-end tests using Playwright verify complete user workflows.

```
e2e/
├── server.spec.ts              # Basic server functionality
├── config.spec.ts              # Config file watcher
├── toolbar/
│   ├── toolbar.visibility.spec.ts  # Toolbar display
│   ├── toolbar.minimize.spec.ts    # Minimize functionality
│   ├── toolbar.sync.spec.ts        # Sync button
│   └── toolbar.popups.spec.ts      # Popup notifications
└── config-watcher/
    ├── watcher.reload.spec.ts      # Config change detection
    └── watcher.debounce.spec.ts    # Debounce behavior
```

**Run E2E tests:**
```bash
npm run test:e2e     # Run all E2E tests via Docker
npm run test:e2e:ui  # Run with Playwright UI
```

## Running All Tests

```bash
npm run test:all  # Runs unit, integration, and E2E tests
```

## Test Configuration Files

| File | Purpose |
|------|---------|
| `vitest.config.ts` | Unit test configuration |
| `vitest.integration.config.ts` | Integration test configuration |
| `playwright.config.ts` | E2E test configuration |
| `tests/tsconfig.json` | TypeScript config for tests |
| `tests/setup.ts` | Global test setup |

## Test Environment Variables

For E2E tests:
- `TEST_TYPE` - Type of test (dev-commonjs, dev-nextjs, dev-nextjs-cjs, config)
- `BASE_URL` - Base URL for the test server

## Writing Tests

### Unit Test Example

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('MyFunction', () => {
  it('should do something', () => {
    const result = myFunction('input');
    expect(result).toBe('expected');
  });
});
```

### Integration Test Example

```typescript
import { describe, it, expect } from 'vitest';
import { initPPRedirect } from '../../../src/lib/pp-redirect.middleware.js';

describe('PP Redirect Middleware', () => {
  it('should redirect root to base path', async () => {
    const middleware = initPPRedirect('/p/template/', 'template');
    // Test middleware behavior...
  });
});
```

### E2E Test Example

```typescript
import { test, expect } from '@playwright/test';

test('should display toolbar', async ({ page, baseURL }) => {
  await page.goto(baseURL!);
  await expect(page.locator('.pp-dev-info')).toBeVisible();
});
```

## Coverage Reports

Coverage reports are generated in:
- `coverage/unit/` - Unit test coverage
- `coverage/integration/` - Integration test coverage
- `playwright-report/` - E2E test reports

## Docker Testing

E2E tests run in Docker containers for isolation:

```bash
# Build test image
docker build -f Dockerfile -t pp-dev-tests .

# Run specific test type
docker run --rm -p 3000:3000 pp-dev-tests dev-commonjs
```

See `tests/README.md` for more details on Docker testing.

## Debugging Tests

### Unit/Integration Tests
```bash
npm run test:unit -- --reporter=verbose
npm run test:integration -- --reporter=verbose
```

### E2E Tests
```bash
npx playwright test --debug
npx playwright test --ui
```

## Test Fixtures

Test fixtures and mock data are located in:
- `tests/test-commonjs/` - CommonJS/Vite test project
- `tests/test-nextjs/` - Next.js ESM test project
- `tests/test-nextjs-cjs/` - Next.js CJS test project

## Known Issues

1. **Config normalization spread bug**: The `normalizeVitePPDevConfig` function has a bug where `...config` at the end overwrites normalized values. Tests document this behavior with comments.

2. **Next.js toolbar tests**: Toolbar E2E tests are skipped for Next.js as the toolbar injection works differently.
