# pp-dev — Claude Code Instructions

## What this project is

`@metricinsights/pp-dev` is a Vite/Next.js-based **local development framework and build tool** for Metric Insights' Portal Pages. It:
- Proxies API requests to a live MI instance
- Injects a **dev panel** (minimize, template sync) into the served page
- Synchronizes the built template back to MI via WebSocket-triggered `next build` / Vite build

## Essential commands

```bash
npm run build          # Build node + client bundles; also packs a .tgz
npm run test           # Unit + integration (vitest)
npm run test:unit      # Unit tests only
npm run test:integration # Integration tests (forked processes)
npm run audit:all      # npm audit in root AND every tests/* package — always use this, never bare npm audit
```

## After any dependency change

Always verify with the **repo-wide audit**, not just root:
```bash
npm run audit:all
```
This runs `npm audit` in root + `tests/test-commonjs`, `tests/test-nextjs`, `tests/test-nextjs-cjs`. All must exit 0.

If test-fixture lockfiles need patching, add/update `overrides` in their `package.json` and run `npm install` there.

## After changing root package source

```bash
npm run reinstall:all  # builds dist/ + .tgz, then reinstalls in all test fixtures
```

## Architecture overview

```
src/cli.ts          — 8 CLI commands: serve (default), next, build, changelog, …
src/index.ts        — withPPDev() Vite config builder; loads pp-dev.config.*
src/plugin.ts       — Vite plugin interface (re-exported)
src/lib/
  client.service.ts — WebSocket event handler (info-data, template:sync, …)
  dist.service.ts   — Build artifact manager: backups, VERSION, BUILD-MANIFEST, zip
  dev-panel.ts      — EJS panel injection + static asset middleware
  pp-ws-server.ts   — Raw ws server for Next.js (Vite-WS-compatible facade)
  version-manifest.ts — VERSION file + BUILD-MANIFEST generation (shared)
  middleware/       — Request pipeline: redirect → proxy cache → load-pp-data → proxy-pass → rewrite-response
src/plugins/
  client-injection-plugin.ts — Vite transformIndexHtml: injects panel markup
  version-plugin.ts — Vite build hook: writes VERSION into dist
src/client/
  index.ts          — Browser-side dev panel (sync button, minimize)
  hot-context.ts    — import.meta.hot shim for Next.js WS transport
```

**WebSocket transport:** Vite dev server uses Vite HMR WS. Next.js uses `PPDevHotServer` (raw `ws`, path `/@pp-dev-hmr`). The client picks whichever is available: `import.meta.hot ?? createPPDevHotContext()`.

## Test structure

| Suite | Config | Pool | Timeout | Location |
|---|---|---|---|---|
| Unit | `vitest.config.ts` | threads | 10 s | `tests/unit/**/*.spec.ts` |
| Integration | `vitest.integration.config.ts` | forks | 30 s | `tests/integration/**/*.spec.ts` |
| E2E | `playwright.config.ts` | browser | — | `e2e/` |

Test fixtures (real apps installed with the local .tgz):
- `tests/test-nextjs/` — ESM Next.js app
- `tests/test-nextjs-cjs/` — CJS Next.js app
- `tests/test-commonjs/` — CommonJS Vite app

## Key conventions

- **Dual ESM/CJS output** — Rollup builds `dist/esm/`, `dist/cjs/`, `dist/types/` from 4 entry points.
- **Config caching** — `src/config.ts` caches loaded config (30 s) and `package.json` (60 s).
- **Lazy heavy imports** — `esbuild`, `jsdom`, `sharp` are imported lazily to keep startup fast.
- **Axios instance cache** — one Axios instance per base URL; `keepAlive: false` avoids max-listeners warnings.
- **No bare `npm audit`** — always `npm run audit:all` so test fixtures are included.

## PR message format

See `.cursor/rules/pr-message-format.mdc`. Use emojis: 🚀 features, 🔧 fixes, 🔐 security, 🧪 tests, 🧹 chore.
