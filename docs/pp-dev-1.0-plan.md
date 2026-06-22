# pp-dev v1.0.0 — Implementation Plan

> **Status:** Approved, ready for implementation
> **Branch:** pp-3449
> **Related:** [PP-3449](https://linear.app/metricinsights/issue/PP-3449/pp-dev-v10), [PP-3440](https://linear.app/metricinsights/issue/PP-3440/polish-pp-dev-ui-to-fit-with-core-mi-ui)
> **Config spec:** [pp-dev-config-1.0-canvas.md](./pp-dev-config-1.0-canvas.md)
> **Design decisions:** [pp-dev-config-1.0-design-notes.md](./pp-dev-config-1.0-design-notes.md)

---

## 1. New configuration schema

Full replacement of flat `VitePPDevOptions` → grouped `PPDevConfig`:

```ts
{
  mi:    { url, token, mode, include, apiVersion }
  app:   { id, type, name }
  proxy: { cache, cacheTtl, tls: { allowSelfSigned } }
  build: { outDir, zip, versionFile, imageOptimisations }
  sync:  { backupsDir }
}
```

### Defaults

| Field | Default |
| --- | --- |
| `mi.mode` | `'standalone'` |
| `mi.apiVersion` | `7` |
| `app.type` | `'template'` |
| `app.name` | resolved from `package.json#name` |

### Validation rules

| # | Condition | Action |
| --- | --- | --- |
| 1 | `mi.include` set + `mi.mode !== 'standalone'` | warn → error |
| 2 | `mi.url` missing + (`mi.mode === 'embedding'` OR `app.type === 'template'`) | error |
| 3 | `mi.url` missing + `mi.mode === 'standalone'` + `app.type === 'page'` | warning |
| 4 | `app.type === 'template'` without `app.id` | error |
| 5 | `app.type === 'page'` + `mi.mode === 'standalone'` without `app.id` | error |
| 6 | `app.name` missing and no `package.json#name` | error |

### Files to change

- [ ] `src/plugin.ts` — new `PPDevConfig` type, new normalization (maps to internal vars)
- [ ] `src/config.ts` — new types, remove `PPWatchConfig` + watch-loader
- [ ] `src/constants.ts` — remove `PP_WATCH_CONFIG_NAMES`
- [ ] `src/cli.ts` — remove watch-config logic
- [ ] `src/index.ts` — update exports
- [ ] `src/lib/dev-panel.ts` — `portalPageId` → `appId`
- [ ] `src/client/index.html` — label "Portal page ID:" → "App ID:"
- [ ] `tests/unit/config/` — update tests

### Removed in 1.0

| Removed | Replacement |
| --- | --- |
| `backendBaseURL` | `mi.url` |
| `personalAccessToken` | `mi.token` |
| `miHudLess` | `mi.mode` |
| `integrateMiTopBar` | `mi.include` |
| `v7Features` | `mi.apiVersion` |
| `appId` / `portalPageId` | `app.id` |
| `templateName` (required) | `app.name` (auto from `package.json#name`) |
| `templateLess` | `app.type` |
| `enableProxyCache` | `proxy.cache` |
| `proxyCacheTTL` | `proxy.cacheTtl` |
| `disableSSLValidation` | `proxy.tls.allowSelfSigned` |
| `distZip` | `build.zip` |
| `versionPlugin` | `build.versionFile` |
| `imageOptimizer` | `build.imageOptimisations` |
| `outDir` | `build.outDir` |
| `syncBackupsDir` | `sync.backupsDir` |
| `pp-watch.config.*` / `.pp-watch.config.*` | Not supported — use `pp-dev.config.*` |
| `PPWatchConfig` type | — |

---

## 2. `defineConfig()` helper

- [ ] Add to `src/helpers.ts`
- [ ] Export from `src/index.ts`

```ts
import { defineConfig } from '@metricinsights/pp-dev';

export default defineConfig({
  mi: { url: 'https://mi.company.com', mode: 'standalone' },
  app: { id: 937 },
});
```

---

## 3. Codemod / migration script

Automatic migration of `pp-dev.config.*` from 0.x → 1.0 format.

- [ ] Implement as a CLI command: `pp-dev migrate` (or standalone script)
- [ ] Transform flat options to grouped structure

### Mapping

| 0.x | 1.0 |
| --- | --- |
| `backendBaseURL` | `mi.url` |
| `personalAccessToken` | `mi.token` |
| `miHudLess: true` | `mi.mode: 'standalone'` |
| `miHudLess: false` | `mi.mode: 'embedding'` |
| `integrateMiTopBar: true` | `mi.mode: 'standalone'`, `mi.include: 'top-bar'` |
| `integrateMiTopBar: { addSharedComponentsScripts: true, addRootElement: false }` | `mi.include: 'shared-components'` |
| `v7Features: true` | `mi.apiVersion: 7` |
| `v7Features: false` | `mi.apiVersion: 6` |
| `appId` / `portalPageId` | `app.id` |
| `templateName` | `app.name` (or omit if matches `package.json#name`) |
| `templateLess: true` | `app.type: 'page'` |
| `templateLess: false` | `app.type: 'template'` |
| `enableProxyCache` | `proxy.cache` |
| `proxyCacheTTL` | `proxy.cacheTtl` |
| `disableSSLValidation: true` | `proxy.tls.allowSelfSigned: true` |
| `distZip` | `build.zip` |
| `versionPlugin` | `build.versionFile` |
| `imageOptimizer` | `build.imageOptimisations` |
| `outDir` | `build.outDir` |
| `syncBackupsDir` | `sync.backupsDir` |

---

## 4. UI redesign (PP-3440)

### Color palette (`src/client/assets/css/client.scss`)

| CSS variable | Current | New |
| --- | --- | --- |
| `--pp-dev-info-color-primary` | `#007bff` | `#075B7E` |
| `--pp-dev-info-color-success` | `#28a745` | `#077E45` |
| `--pp-dev-info-color-danger` | `#dc3545` | `#AC2B2B` |
| `--pp-dev-info-color-warning` | `#ffc107` | `#FFB000` |
| `--pp-dev-info-color-secondary` | `#6c757d` | `rgba(34,34,34,0.64)` |

Add: `font-family: 'Inter', sans-serif` to panel `*` reset.

### Toast (popup)

- [ ] Remove colored `background-color` from `.pp-dev-info__popup-title`
- [ ] Replace with `border: 2px solid <color>` on the popup wrapper
- [ ] `border-radius: 8px` → `2px`
- [ ] `max-width: 300px` → `280px`
- [ ] Title row: icon + text + close button in one row (no separate colored header block)

### Modal (confirm dialog)

- [ ] `min(500px, …)` → `408px` fixed width
- [ ] `border-radius: 10px` → `3px`
- [ ] `box-shadow` → `0px 8px 32px 0px rgba(34,34,34,0.4)`
- [ ] Footer buttons: full-width, column stack (not row with `justify-end`)

### Buttons (toggle + sync)

- [ ] Size: `24px` → `28px`
- [ ] Add `border: 1px solid #075B7E`, `border-radius: 3px`, `padding: 6px`

### Panel container

- [ ] `border-radius: 8px 0 0 0` → `4px 0 0 0`
- [ ] `box-shadow: 0 -2px 4px rgba(0,0,0,0.1)` → `-2px -2px 8px 0px rgba(34,34,34,0.08)`
- [ ] Add `border-bottom: 1px solid rgba(34,34,34,0.08)`

---

## 5. Release prep

- [ ] `CHANGELOG.md` — full breaking changes list + migration guide
- [ ] Bump version to `1.0.0` in `package.json`
- [ ] `npm run reinstall:all`
- [ ] `npm run test`
- [ ] `npm run audit:all`
