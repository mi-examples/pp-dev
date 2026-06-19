# pp-dev 1.0.0 — Design notes (chat summary)

> **Created:** 2025-06-05  
> **Purpose:** Context for resuming config redesign after team discussion  
> **Full spec for Slack/review:** [pp-dev-config-1.0-canvas.md](./pp-dev-config-1.0-canvas.md)

---

## Goal

Prepare `@metricinsights/pp-dev` **v1.0.0** with:

- Removal of deprecated 0.x options
- Renamed, grouped configuration
- Clearer domain model (MI embedding, app type, proxy, build)

This is a **breaking change**.

---

## Evolution of decisions (why things changed)

### 1. Flat options → grouped config

0.x `VitePPDevOptions` is a flat list mixing unrelated concerns. 1.0 groups into:

| Block | Responsibility |
| --- | --- |
| `mi` | MI instance URL, auth, how page embeds into MI |
| `app` | App identity and type on MI |
| `proxy` | Dev-server proxy to MI backend |
| `build` | Build output and post-processing |
| `sync` | Asset backup dir for CLI sync |

### 2. No separate `template` block

Initial idea had `template: { mode, variables }`. **Rejected** because:

- Variables exist **only** in template mode — not a separate axis
- `templateLess` is really **app type**, not “template settings”
- There is no valid state “template without variables”

**Decision:** `app.type: 'page' | 'template'` only. No `variables` flag.

| `app.type` | Replaces | Behavior |
| --- | --- | --- |
| `'page'` | `templateLess: true` | Custom app, path `/p/<name>`, `getPageTemplate()` |
| `'template'` | `templateLess: false` | Template page, path `/pl/` or `/pt/`, always loads variables via `getPageVariables(appId)` |

### 3. No `shell` / no single `embedding` enum

`shell` was rejected — options describe **how the page embeds in MI**, not a generic “shell”.

First unified enum `embedding: 'embedded' | 'standalone' | 'shared-components' | 'top-bar'` was split further:

**Decision:** two fields under `mi`:

- `mi.mode` — primary integration mode
- `mi.include` — optional MI assets (only for `standalone`)

### 4. `mi.mode` + `mi.include`

#### `mi.mode`

| Value | Replaces | Meaning |
| --- | --- | --- |
| `'standalone'` | `miHudLess: true` | Full HTML control; MI adds nothing. Recommended for React/SPA |
| `'embedding'` | `miHudLess: false` | Code injected inside MI backend HTML wrapper in `<body>`. Not recommended for React |

**Default (proposed):** `'embedding'` (matches current 0.x default)

#### `mi.include` (only when `mode === 'standalone'`)

| Value | Replaces | Meaning |
| --- | --- | --- |
| *(omitted)* | no `integrateMiTopBar` | Nothing from MI core |
| `'shared-components'` | `integrateMiTopBar: { addSharedComponentsScripts: true, addRootElement: false }` | `/auth/info.js`, `/js/main.js`, `/css/main.css` — no `#mi-react-root` |
| `'top-bar'` | `integrateMiTopBar: true` | shared-components **plus** `<div id="mi-react-root">` |

**Rules:**

- `top-bar` **always implies** `shared-components` — cannot exist alone
- If `mode === 'embedding'` and `include` is set → **configuration error** (not warn+ignore, unless team decides otherwise during migration)

### 5. `app` fields

| Field | Replaces | Notes |
| --- | --- | --- |
| `app.id` | `appId` (drop `portalPageId`) | Required for `type: 'template'` always; for `type: 'page'` when `mi.mode: 'standalone'` |
| `app.name` | `templateName` | Auto from `package.json#name` when omitted — no longer required in config |
| `app.type` | `templateLess` | `'page' \| 'template'` |

### 6. Other renames

| 0.x | 1.0 |
| --- | --- |
| `backendBaseURL` | `mi.url` |
| `personalAccessToken` | `mi.token` |
| `v7Features` | `mi.apiVersion: 6 \| 7` (or remove `6` entirely) |
| `enableProxyCache` | `proxy.cache` |
| `proxyCacheTTL` | `proxy.cacheTtl` |
| `disableSSLValidation: true` | `proxy.tls.allowSelfSigned: true` |
| `distZip` | `build.zip` |
| `versionPlugin` | `build.versionFile` |
| `imageOptimizer` | `build.imageOptimisations` |
| `outDir` | `build.outDir` |
| `syncBackupsDir` | `sync.backupsDir` |

### 7. `pp-watch` configs — not supported in 1.0

Legacy pre-public config files (`pp-watch.config.*`, `.pp-watch.config.*`) will be **removed**.

Only `pp-dev.config.*` and `package.json#pp-dev` remain.

---

## Proposed final shape (quick reference)

```ts
export default {
  mi: {
    url: 'https://mi.company.com',
    token: process.env.MI_ACCESS_TOKEN,
    mode: 'standalone',
    include: 'top-bar',
    apiVersion: 7,
  },
  app: {
    id: 937,
    type: 'template',
  },
  proxy: {
    cache: true,
    cacheTtl: 600_000,
    tls: { allowSelfSigned: false },
  },
  build: {
    outDir: 'dist',
    zip: true,
    versionFile: true,
    imageOptimisations: true,
  },
  sync: {
    backupsDir: 'backups',
  },
};
```

---

## Validation rules (agreed / proposed)

1. `mi.mode === 'embedding'` + `mi.include` set → **error**
2. `app.type === 'template'` without `app.id` → **error**
3. `app.type === 'page'` + `mi.mode === 'standalone'` without `app.id` → **error**
4. `app.name` missing and no `package.json#name` → **error**

---

## Open questions (for team discussion)

Track answers here after the review:

| # | Question | Decision |
| --- | --- | --- |
| 1 | `mi.apiVersion` — keep `6 \| 7` or only `7`? | _TBD_ |
| 2 | Default `mi.mode` — `embedding` or `standalone`? | _TBD_ |
| 3 | Missing `mi.url` — warning or error? | _TBD_ |
| 4 | `include` + `embedding` — strict error only, or warn during migration? | _TBD_ (leaning: error) |
| 5 | Top-level `outDir` for Vite compat, or only `build.outDir`? | _TBD_ |
| 6 | Provide codemod / migration script for 0.x configs? | _TBD_ |

---

## Implementation notes (when resuming work)

### Internal normalization (minimal runtime change)

Map new config to existing internals during transition:

```ts
const miHudLess = mi.mode === 'standalone';
const integrateMiTopBar =
  mi.include === 'top-bar'
    ? true
    : mi.include === 'shared-components'
      ? { addSharedComponentsScripts: true, addRootElement: false }
      : false;
const templateLess = app.type === 'page';
```

### Files likely to touch

- `src/plugin.ts` — `VitePPDevOptions`, validation, normalization
- `src/config.ts` — `PPDevConfig`, remove `PPWatchConfig` + watch loader
- `src/constants.ts` — remove `PP_WATCH_CONFIG_NAMES`
- `src/cli.ts` — config loading, remove watch names
- `src/index.ts` — exports
- `pp-dev.d.ts` — module declarations
- `README.md`, `CHANGELOG.md`
- Tests under `tests/unit/config/`

### Artifacts from this chat

| File | Contents |
| --- | --- |
| [pp-dev-config-1.0-canvas.md](./pp-dev-config-1.0-canvas.md) | Full schema, tables, migration map — ready for Slack Canvas |
| [pp-dev-config-1.0-design-notes.md](./pp-dev-config-1.0-design-notes.md) | This summary |

---

## Removed in 1.0 (checklist)

- [ ] `portalPageId`
- [ ] `templateLess`
- [ ] `miHudLess`
- [ ] `integrateMiTopBar`
- [ ] `v7Features` (or replace with `mi.apiVersion`)
- [ ] Required `templateName` in config
- [ ] `pp-watch.config.*` / `.pp-watch.config.*` support
- [ ] `PPWatchConfig` type and exports
