# pp-dev 1.0.0 — Configuration Schema (DRAFT)

> **Status:** Design proposal for team review
> **Target:** `@metricinsights/pp-dev` v1.0.0
> **Breaking changes:** yes — flat 0.x options replaced by grouped config
> **Design notes:** [pp-dev-config-1.0-design-notes.md](./pp-dev-config-1.0-design-notes.md)

---

## Goals

- Remove deprecated options (`portalPageId`, `templateLess`, `miHudLess`, `integrateMiTopBar`, …)
- Remove legacy pre-release config (`pp-watch.config.*`, `.pp-watch.config.*`)
- Use positive, domain-driven naming
- Group options by responsibility: `mi`, `app`, `proxy`, `build`, `sync`
- Make invalid combinations impossible via validation

---

## Example config

```ts
// pp-dev.config.ts
import type { PPDevConfig } from '@metricinsights/pp-dev';

export default {
  mi: {
    url: 'https://mi.company.com',
    token: process.env.MI_ACCESS_TOKEN,
    mode: 'standalone',
    include: 'top-bar',
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
} satisfies PPDevConfig;
```

`app.name` is omitted — resolved from `package.json#name`.

---

## Config sources

| Source | Location |
| --- | --- |
| Config file | `pp-dev.config.{js,cjs,ts,json}` |
| package.json | `"pp-dev": { ... }` |

> `pp-watch.config.*` and `.pp-watch.config.*` are **not supported** in 1.0 (legacy pre-release).

---

# `mi` — MI instance & page embedding

## `mi.mode`

How the local page integrates into Metric Insights.

| Value | Behavior | Replaces |
| --- | --- | --- |
| `standalone` | Full control over HTML. MI does not inject wrapper or scripts. Recommended for React/SPA. | `miHudLess: true` |
| `embedding` | Page content embedded inside MI backend HTML wrapper (inside `<body>`). Not recommended for React. | `miHudLess: false` |

**Default:** `standalone`

## `mi.include`

Optional MI shared resources bundled into the build.
**Only valid when `mi.mode` is `standalone`.**

| Value | Behavior | Replaces |
| --- | --- | --- |
| *(omitted)* | Nothing from MI core added | `integrateMiTopBar: false` |
| `shared-components` | Injects `/auth/info.js`, `/js/main.js`, `/css/main.css`. No `#mi-react-root`. | `integrateMiTopBar: { addSharedComponentsScripts: true, addRootElement: false }` |
| `top-bar` | `shared-components` + `<div id="mi-react-root">` in `<body>` | `integrateMiTopBar: true` |

> `top-bar` always implies `shared-components`. Cannot exist without them.

### Validation

| Condition | Action |
| --- | --- |
| `include` is set + `mode !== 'standalone'` | **warn → error** |

## Other `mi` fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string` | `process.env.MI_BACKEND_URL` | MI instance base URL. Replaces `backendBaseURL`. |
| `token` | `string` | `process.env.MI_ACCESS_TOKEN` | Personal Access Token. Replaces `personalAccessToken`. |
| `apiVersion` | `6 \| 7` | `7` | API/routing version. Replaces `v7Features`. **TBD:** drop `6` in 1.0? |

---

# `app` — application identity & type

## `app.type`

| Value | Dev path (v7) | Data loading | Replaces |
| --- | --- | --- | --- |
| `page` | `/p/<name>` | Generic page template from MI | `templateLess: true` |
| `template` | `/pl/<name>` | Template variables for `app.id` (always) | `templateLess: false` |

**Default:** `template`

> Template mode always loads variables — no separate `variables` flag.

## Other `app` fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | `number` | — | Portal page / app ID on MI. Replaces `appId`. |
| `name` | `string` | `package.json#name` | Internal asset name for URLs and ZIP. Replaces `templateName`. |

### When is `app.id` required?

| `app.type` | `mi.mode` | `app.id` |
| --- | --- | --- |
| `template` | any | **Required** |
| `page` | `standalone` | **Required** |
| `page` | `embedding` | Optional |

---

# `proxy` — dev-server proxy

| Field | Type | Default | Replaces |
| --- | --- | --- | --- |
| `cache` | `boolean` | `true` | `enableProxyCache` |
| `cacheTtl` | `number` (ms) | `600_000` | `proxyCacheTTL` |
| `tls.allowSelfSigned` | `boolean` | `false` | `disableSSLValidation: true` |

---

# `build` — build output & post-processing

| Field | Type | Default | Replaces |
| --- | --- | --- | --- |
| `outDir` | `string` | `'dist'` | `outDir` |
| `zip` | `boolean \| object` | `true` | `distZip` |
| `versionFile` | `boolean \| object` | `true` | `versionPlugin` |
| `imageOptimisations` | `boolean \| object` | `true` | `imageOptimizer` |

### `build.zip` object

| Field | Default |
| --- | --- |
| `fileName` | `'[name].zip'` |
| `outDir` | `'dist-zip'` |
| `inDir` | value of `build.outDir` |

### `build.versionFile` object

| Field | Default |
| --- | --- |
| `enabled` | `true` |
| `fileNameTemplate` | `'VERSION-v{packageversion}-{currentDate}.json'` |

---

# `sync` — asset sync / backups

| Field | Type | Default | Replaces |
| --- | --- | --- | --- |
| `backupsDir` | `string` | `'backups'` | `syncBackupsDir` |

---

# Matrix: `mi.mode` × `mi.include`

| `mi.mode` | `mi.include` | Result |
| --- | --- | --- |
| `embedding` | — | MI backend wrapper |
| `embedding` | any value | **warn → error** (`include` requires `standalone`) |
| `standalone` | — | Full HTML control, no MI assets |
| `standalone` | `shared-components` | + MI scripts & styles |
| `standalone` | `top-bar` | + scripts/styles + `#mi-react-root` |

---

# Matrix: `app.type` × `mi.mode`

| `app.type` | `mi.mode` | Dev path (api v7) | `app.id` |
| --- | --- | --- | --- |
| `page` | `standalone` | `/p/<name>` | required |
| `page` | `embedding` | `/p/<name>` | optional |
| `template` | `standalone` | `/pl/<name>` | required |
| `template` | `embedding` | `/pl/<name>` | required |

---

# Migration map (0.x → 1.0)

| 0.x | 1.0 |
| --- | --- |
| `backendBaseURL` | `mi.url` |
| `personalAccessToken` | `mi.token` |
| `miHudLess: true` | `mi.mode: 'standalone'` |
| `miHudLess: false` | `mi.mode: 'embedding'` |
| `integrateMiTopBar: true` | `mi.mode: 'standalone'`, `mi.include: 'top-bar'` |
| `integrateMiTopBar: { addSharedComponentsScripts: true }` | `mi.include: 'shared-components'` |
| `v7Features: true/false` | `mi.apiVersion: 7/6` |
| `appId` / `portalPageId` | `app.id` |
| `templateName` | `app.name` (auto from package.json) |
| `templateLess: true/false` | `app.type: 'page'/'template'` |
| `enableProxyCache` | `proxy.cache` |
| `proxyCacheTTL` | `proxy.cacheTtl` |
| `disableSSLValidation: true` | `proxy.tls.allowSelfSigned: true` |
| `distZip` | `build.zip` |
| `versionPlugin` | `build.versionFile` |
| `imageOptimizer` | `build.imageOptimisations` |
| `outDir` | `build.outDir` |
| `syncBackupsDir` | `sync.backupsDir` |
| `pp-watch.config.*` | Not supported — use `pp-dev.config.*` |

---

# TypeScript interfaces (reference)

```ts
export interface PPDevConfig {
  mi?: MiConfig;
  app?: AppConfig;
  proxy?: ProxyConfig;
  build?: BuildConfig;
  sync?: SyncConfig;
}

export type MiMode = 'standalone' | 'embedding';
export type MiInclude = 'shared-components' | 'top-bar';
export type AppType = 'page' | 'template';

export interface MiConfig {
  url?: string;
  token?: string;
  mode?: MiMode;       // default: 'embedding'
  include?: MiInclude; // only when mode === 'standalone'
  apiVersion?: 6 | 7;  // default: 7 — TBD: remove 6?
}

export interface AppConfig {
  id?: number;
  name?: string;       // default: package.json#name
  type?: AppType;      // default: 'template'
}

export interface ProxyConfig {
  cache?: boolean;
  cacheTtl?: number;
  tls?: { allowSelfSigned?: boolean };
}

export interface BuildConfig {
  outDir?: string;
  zip?: boolean | { fileName?: string; outDir?: string; inDir?: string };
  versionFile?: boolean | { enabled?: boolean; fileNameTemplate?: string };
  imageOptimisations?: boolean | Record<string, unknown>;
}

export interface SyncConfig {
  backupsDir?: string;
}
```

---

# Common scenarios

### React app (recommended)

```ts
mi: { mode: 'standalone', include: 'top-bar' }
app: { id: 937, type: 'template' }
```

### Standalone page, no MI chrome

```ts
mi: { mode: 'standalone' }
app: { id: 937, type: 'page' }
```

### Legacy / non-React

```ts
mi: { mode: 'embedding' }
app: { id: 937, type: 'template' }
```

### Invalid

```ts
mi: { mode: 'embedding', include: 'top-bar' }  // Error
```

---

# Open questions for discussion

- [x] `mi.apiVersion` — keep `6 | 7`, default `7`
- [x] Default `mi.mode` — `standalone`
- [x] Missing `mi.url` — **warning** when `mode=standalone` + `app.type=page`; **error** otherwise (`embedding` always needs backend; `template` always needs backend for variables)
- [x] `include` with `embedding` — warn → error (log warning, then throw)
- [x] Top-level `outDir` — removed; only `build.outDir`
- [x] Provide codemod / migration script for 0.x configs — yes

---

# Removed in 1.0

| Removed | Replacement |
| --- | --- |
| `pp-watch.config.*` / `.pp-watch.config.*` (pre-release legacy) | Not supported — use `pp-dev.config.*` only |
| `portalPageId` | `app.id` |
| `templateLess` | `app.type` |
| `miHudLess` | `mi.mode` |
| `integrateMiTopBar` | `mi.include` |
| `v7Features` | `mi.apiVersion` (or removed) |
| `templateName` (required) | `app.name` (auto-resolved) |
