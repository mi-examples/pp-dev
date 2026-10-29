# pp-dev Testing Guide

How the pp-dev tests are organized and how to run them.

## Test Architecture

### 1. Unit Tests (`tests/unit/`)

Isolated functions and modules: `api/`, `client/` (dev panel, under jsdom), `config/`, `helpers/`, `lib/`, `mock-mi/`, `plugin/`.

```bash
npm run test:unit           # Run once
npm run test:unit:watch     # Watch mode
npm run test:unit:coverage  # With coverage report (coverage/unit/)
```

### 2. Integration Tests (`tests/integration/`)

Middleware and servers working together over real HTTP and WebSocket connections (`tests/integration/middleware/`). They run in forked processes.

```bash
npm run test:integration        # Run once
npm run test:integration:watch  # Watch mode
```

### 3. Server lifecycle E2E (`tests/e2e/`)

Vitest starts the `pp-dev` and `pp-dev next` dev servers of the test fixtures as child processes and checks startup, restarts and shutdown. The fixtures must have the current package installed: run `npm run reinstall:all` after changing `src/`.

```bash
npm run test:e2e
```

### 4. Browser E2E (`e2e/`)

Playwright tests of the dev panel, config watcher and users. `scripts/run-playwright-e2e.ts` starts a mock MI server (`tests/mock-mi/`), starts a dev server for each fixture and runs Playwright against it.

```bash
npm run test:e2e:browser  # All fixtures, against the recorded mock MI
npm run test:e2e:ui       # Playwright UI
```

Environment variables of the runner:

- `PP_DEV_E2E_FIXTURES`: comma-separated fixtures to run (`commonjs`, `nextjs`, `nextjs-cjs`; default: all).
- `PP_DEV_E2E_MOCK_MODE`: `replay` (default) serves the recorded cassettes; `record` proxies a real MI at `REAL_MI_URL` and records them.
- `PP_DEV_E2E_CASSETTE`: the cassette to use (default `startup`).
- `PP_DEV_E2E_COMMONJS_PORT`, `PP_DEV_E2E_NEXTJS_PORT`, `PP_DEV_E2E_NEXTJS_CJS_PORT`: dev server ports (3105, 3106, 3107).

The specs read `TEST_TYPE` (`dev-commonjs`, `dev-nextjs`, `dev-nextjs-cjs`) and `BASE_URL`, which the runner sets.

Record new cassettes from a real MI with `npm run record:mi`.

## Running Tests

```bash
npm run test      # Same as test:all
npm run test:all  # Unit and integration tests (not the E2E suites)
```

CI also runs `test:e2e` and `test:e2e:browser`.

## Test Configuration Files

| File                           | Purpose                             |
| ------------------------------ | ----------------------------------- |
| `vitest.config.ts`             | Unit tests                          |
| `vitest.integration.config.ts` | Integration tests                   |
| `vitest.e2e.config.ts`         | Server lifecycle E2E (`tests/e2e/`) |
| `playwright.config.ts`         | Browser E2E (`e2e/`)                |
| `tests/tsconfig.json`          | TypeScript config for tests         |
| `tests/setup.ts`               | Global unit test setup              |

## Writing Tests

### Unit Test Example

```typescript
import { describe, it, expect } from 'vitest';

describe('MyFunction', () => {
  it('should do something', () => {
    const result = myFunction('input');
    expect(result).toBe('expected');
  });
});
```

### Integration Test Example

```typescript
import { describe, it } from 'vitest';
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

## Reports

- `coverage/unit/`: unit test coverage
- `coverage/integration/`: integration test coverage
- `playwright-report/`: browser E2E reports

## Debugging Tests

```bash
npm run test:unit -- --reporter=verbose
npm run test:integration -- --reporter=verbose
npm run test:e2e:browser -- --debug
```

## Test Fixtures

Real apps that install the local `.tgz` of the package:

- `tests/test-commonjs/`: CommonJS Vite app
- `tests/test-nextjs/`: Next.js ESM app
- `tests/test-nextjs-cjs/`: Next.js CJS app

## Known Issues

- **Next.js toolbar tests**: the toolbar E2E tests are skipped for the Next.js fixtures, where the panel is injected differently.
