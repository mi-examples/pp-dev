# [1.1.0-beta.1](https://github.com/mi-examples/pp-dev/compare/v1.0.0...v1.1.0-beta.1) (2026-07-21)


### Bug Fixes

* address new npm audit advisories in root and test fixtures ([c02c3dc](https://github.com/mi-examples/pp-dev/commit/c02c3dc94a06d238df3c4383fb906b335db54eed))


### Features

* add `next-build` command for Next.js build output parity with `pp-dev build` ([f16871e](https://github.com/mi-examples/pp-dev/commit/f16871ebbc05588800805cb2bd1ccfd27d25f763))
* extract shared next-build helpers and CLI/env build-output overrides ([cd455ac](https://github.com/mi-examples/pp-dev/commit/cd455ac4b8488178f72416d43267b4545aa508c9))

# [1.0.0-beta.2](https://github.com/mi-examples/pp-dev/compare/v1.0.0-beta.1...v1.0.0-beta.2) (2026-07-07)


### Features

* **PP-3449:** add Dev Panel guide to README (position, auto-hide, hide/restore) ([54b8331](https://github.com/mi-examples/pp-dev/commit/54b833163bf65372f6ba55f5910cd7e3332261a9))

# [1.0.0-beta.1](https://github.com/mi-examples/pp-dev/compare/v0.20.0-beta.6...v1.0.0-beta.1) (2026-07-07)


* feat(PP-3449)!: update dependencies and start the 1.0 release line ([abdad45](https://github.com/mi-examples/pp-dev/commit/abdad45b87e752d7468994f821841adc9e288e70))


### Features

* **PP-3449:** add Dev Panel guide to README (position, auto-hide, hide/restore) ([54b8331](https://github.com/mi-examples/pp-dev/commit/54b833163bf65372f6ba55f5910cd7e3332261a9))


### BREAKING CHANGES

* pp-dev moves to the 1.0 release line. Node.js >= 24
is required (declared in engines) and the package is no longer
published under the 0.x version scheme.

# [1.0.0-beta.1](https://github.com/mi-examples/pp-dev/compare/v0.20.0-beta.6...v1.0.0-beta.1) (2026-07-07)


* feat(PP-3449)!: update dependencies and start the 1.0 release line ([abdad45](https://github.com/mi-examples/pp-dev/commit/abdad45b87e752d7468994f821841adc9e288e70))


### BREAKING CHANGES

* pp-dev moves to the 1.0 release line. Node.js >= 24
is required (declared in engines) and the package is no longer
published under the 0.x version scheme.

# [0.20.0-beta.6](https://github.com/mi-examples/pp-dev/compare/v0.20.0-beta.5...v0.20.0-beta.6) (2026-07-06)


### Features

* **PP-3449:** configurable dev panel position, hide and auto-hide modes ([315d6fc](https://github.com/mi-examples/pp-dev/commit/315d6fc4182c1128f77fe192a425e3f816970f6f))

# [0.20.0-beta.5](https://github.com/mi-examples/pp-dev/compare/v0.20.0-beta.4...v0.20.0-beta.5) (2026-07-06)


### Bug Fixes

* **PP-3449:** stop request inspector from swallowing proxied PUT/POST bodies ([610a993](https://github.com/mi-examples/pp-dev/commit/610a9933ac0a7ec19ee349ff7c6490b605a739ed))

# [0.20.0-beta.4](https://github.com/mi-examples/pp-dev/compare/v0.20.0-beta.3...v0.20.0-beta.4) (2026-07-02)


### Bug Fixes

* **PP-3449:** guard release.yml against non-tag workflow_dispatch runs ([a7f463f](https://github.com/mi-examples/pp-dev/commit/a7f463f7c0e75f3305b2dfab560ee9a6c315343d))

# [0.20.0-beta.3](https://github.com/mi-examples/pp-dev/compare/v0.20.0-beta.2...v0.20.0-beta.3) (2026-07-01)


### Bug Fixes

* **PP-3449:** address PR [#182](https://github.com/mi-examples/pp-dev/issues/182) code review comments ([010a182](https://github.com/mi-examples/pp-dev/commit/010a182136cf72eac0782e38750ea30f9f89f8f8))

# [0.20.0-beta.2](https://github.com/mi-examples/pp-dev/compare/v0.20.0-beta.1...v0.20.0-beta.2) (2026-07-01)


### Bug Fixes

* **ui:** align dev panel with design ([0d020e3](https://github.com/mi-examples/pp-dev/commit/0d020e32c3e1608cafdcc0c7a5b368524867a785))

# [0.20.0-beta.1](https://github.com/mi-examples/pp-dev/compare/v0.19.0...v0.20.0-beta.1) (2026-06-30)


### Bug Fixes

* address code review defects ([c734183](https://github.com/mi-examples/pp-dev/commit/c734183f2b4e7cd901e27502acff42d671d4dff4))
* address review feedback defects ([85e2b80](https://github.com/mi-examples/pp-dev/commit/85e2b80ddc4cdeca9d97682315c4a0417cb34e5a))
* **build:** run rollup-plugin-dts in child process to prevent Windows hang ([d9466b0](https://github.com/mi-examples/pp-dev/commit/d9466b0884f3e0eb5d01ef864e18ba32c6ff7899))
* **ci:** restore fixture package install ([d0ea762](https://github.com/mi-examples/pp-dev/commit/d0ea762c6f9e6802cb3bca22d29f7193a0dcdf9c))
* **e2e:** use taskkill /T /F on Windows to kill pp-dev process tree ([79ca61e](https://github.com/mi-examples/pp-dev/commit/79ca61e2f73144d9584bce762424853c154281e7))
* **mock-mi:** fix broken regex and Windows-incompatible spawn in record.ts ([ad0b033](https://github.com/mi-examples/pp-dev/commit/ad0b0333976b38b362b74a47c8bad239d9b0e75a))
* **mock-mi:** fix remaining TS errors in server.ts ([b538640](https://github.com/mi-examples/pp-dev/commit/b5386404e0fb16f8d5ba03073da507c8f679cb48))
* **mock-mi:** fix TypeScript errors in mock-mi server and record scripts ([f64f835](https://github.com/mi-examples/pp-dev/commit/f64f8350e4353ac90f963feee99ff945c15572bf))
* **mock-mi:** store binary responses as base64 in cassettes ([c6ee828](https://github.com/mi-examples/pp-dev/commit/c6ee82800dc4c621326f4032ea2f2ec606b0545b))
* **security:** patch npm/node-gyp undici <=6.26.0 high-severity CVEs ([d4c8a10](https://github.com/mi-examples/pp-dev/commit/d4c8a10e704c75b6d1c1b7bcd8166d007b5270a2)), closes [hi#severity](https://github.com/hi/issues/severity) [hi#severity](https://github.com/hi/issues/severity)
* **security:** pin undici to ^7.28.0 to fix CVEs without breaking jsdom ([d03bd5e](https://github.com/mi-examples/pp-dev/commit/d03bd5e744e18695a7c05c3e3e6b545e2a00b219))
* **ui:** align panel bar with Figma spec (PP-3449) ([9ed1320](https://github.com/mi-examples/pp-dev/commit/9ed13200bb154753534a29b7f606b3fc663d3076))


### Features

* **inspector:** add Request Inspector with web UI and REST API ([e53fa90](https://github.com/mi-examples/pp-dev/commit/e53fa90639bdb6ed917772169ea2cb4f36de28a8))
* **inspector:** print inspector URL banner to browser DevTools console ([9222397](https://github.com/mi-examples/pp-dev/commit/92223972ec5f649085a76afd22b2328aeafb0e97))
* **mock-mi:** add PAT support and template API fetch to record-auto ([74c3142](https://github.com/mi-examples/pp-dev/commit/74c3142941456d9a8fdaad62fdb1ff956e6b147e))
* **ui:** PP-3440 MI brand redesign — colors, Inter font, SVG type icons ([a0a30a5](https://github.com/mi-examples/pp-dev/commit/a0a30a5aafe07255cc74bb614d36f86a4ee64925)), closes [#075B7E](https://github.com/mi-examples/pp-dev/issues/075B7E) [#077E45](https://github.com/mi-examples/pp-dev/issues/077E45) [#AC2B2B](https://github.com/mi-examples/pp-dev/issues/AC2B2B) [#FFB000](https://github.com/mi-examples/pp-dev/issues/FFB000)
* v1.0 grouped PPDevConfig schema, defineConfig helper, pp-dev migrate codemod ([222b4e5](https://github.com/mi-examples/pp-dev/commit/222b4e5949144295f07dd9fed87e131692323560))

# [1.0.0](https://github.com/mi-examples/pp-dev/compare/v0.19.0-beta.2...v1.0.0) (2026-06-19)

## ⚠ BREAKING CHANGES

This release replaces the flat configuration API with a grouped schema. All existing `pp-dev.config.*` files must be updated — use `pp-dev migrate` to do it automatically.

### Configuration schema

The flat `VitePPDevOptions` object is replaced by `PPDevConfig` with five grouped sections:

```ts
// BEFORE (0.x)
export default {
  backendBaseURL: 'https://mi.company.com',
  personalAccessToken: 'YOUR_TOKEN',
  miHudLess: true,
  v7Features: true,
  appId: 937,
  templateLess: false,
};

// AFTER (1.0)
import { defineConfig } from '@metricinsights/pp-dev';

export default defineConfig({
  mi:    { url: 'https://mi.company.com', token: 'YOUR_TOKEN', mode: 'standalone', apiVersion: 7 },
  app:   { id: 937, type: 'template' },
});
```

| 0.x field | 1.0 field |
|---|---|
| `backendBaseURL` | `mi.url` |
| `personalAccessToken` | `mi.token` |
| `miHudLess: true` | `mi.mode: 'standalone'` |
| `miHudLess: false` | `mi.mode: 'embedding'` |
| `integrateMiTopBar: true` | `mi.mode: 'standalone'`, `mi.include: 'top-bar'` |
| `integrateMiTopBar: { addSharedComponentsScripts: true }` | `mi.include: 'shared-components'` |
| `v7Features: true` | `mi.apiVersion: 7` |
| `v7Features: false` | `mi.apiVersion: 6` |
| `appId` / `portalPageId` | `app.id` |
| `templateName` | `app.name` (auto-resolved from `package.json#name` — usually omit) |
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

### Removed

- `pp-watch.config.*` / `.pp-watch.config.*` config files — use `pp-dev.config.*` instead
- `PPWatchConfig` type
- `VitePPDevOptions` type — use `PPDevConfig`
- `normalizeVitePPDevConfig()` — internal, use `normalizePPDevConfig()`

### Defaults

| Field | Default |
|---|---|
| `mi.mode` | `'standalone'` |
| `mi.apiVersion` | `7` |
| `app.type` | `'template'` |
| `app.name` | resolved from `package.json#name` |

### Validation

Startup validation now throws meaningful errors instead of silently ignoring bad config. Key rules:

- `mi.include` requires `mi.mode: 'standalone'`
- `mi.url` is required when `mi.mode: 'embedding'` or `app.type: 'template'`
- `app.id` is required for templates and standalone pages

### Migration

Run the built-in codemod to upgrade your config automatically:

```bash
npx @metricinsights/pp-dev migrate
# Preview changes first:
npx @metricinsights/pp-dev migrate --dry-run
# Force output format:
npx @metricinsights/pp-dev migrate --format ts
```

The command detects flat 0.x configs and `pp-watch.config.*` files, migrates them to the new grouped format, and writes a `.bak` backup before overwriting.

## Features

* **config:** grouped `PPDevConfig` schema with `mi`, `app`, `proxy`, `build`, `sync` sections
* **config:** `defineConfig()` helper for full TypeScript intellisense
* **cli:** `pp-dev migrate` codemod — auto-migrates 0.x flat and `pp-watch` configs to 1.0 format, supports `--dry-run`, `--format ts|js|json`, `--output`, `--no-backup`
* **ui:** redesigned dev panel — MI brand colors (`#075B7E`), Inter font, bordered buttons, updated toast and confirm modal styles

---

# [0.19.0-beta.2](https://github.com/mi-examples/pp-dev/compare/v0.19.0-beta.1...v0.19.0-beta.2) (2026-06-18)


### Bug Fixes

* address CodeRabbit review findings ([7d50da6](https://github.com/mi-examples/pp-dev/commit/7d50da601627006c06253d7acf3ca06a4974c103))

# [0.19.0-beta.1](https://github.com/mi-examples/pp-dev/compare/v0.18.3-beta.2...v0.19.0-beta.1) (2026-06-17)


### Bug Fixes

* **client:** keep the sync spinner running while confirmation modals are open ([da86bcb](https://github.com/mi-examples/pp-dev/commit/da86bcbe4c4fcfae6df4f99d081da43e8a6a958f))
* **next:** resolve sync export dir from the production config ([8b8275a](https://github.com/mi-examples/pp-dev/commit/8b8275aea0b501d8f3b1aabc6107865eefcac58e))
* **test-nextjs:** exclude build output from type-check to stop duplicate route types ([1ec5e50](https://github.com/mi-examples/pp-dev/commit/1ec5e501f97bf8de8c0634bf628b15e97305b508))


### Features

* **next:** add dev panel for the Next.js dev server ([95dfd8e](https://github.com/mi-examples/pp-dev/commit/95dfd8e8be9e6fc1c63243a62c103eb597893ba9))
* **next:** build template sync assets with `next build` ([f19c42e](https://github.com/mi-examples/pp-dev/commit/f19c42ec2b775706621470ba60185d1324d0b1ec))

## [0.18.3-beta.2](https://github.com/mi-examples/pp-dev/compare/v0.18.3-beta.1...v0.18.3-beta.2) (2026-06-11)


### Bug Fixes

* **client:** send dev-panel WebSocket responses to the requesting client only ([d73700f](https://github.com/mi-examples/pp-dev/commit/d73700f7ab439422651e0fb38e48cbb4e37556e2))
* **middleware:** load template variables on deep-linked sub-path navigation ([a21c032](https://github.com/mi-examples/pp-dev/commit/a21c0323999300f326bdf5845f668a180cb7d121))

## [0.18.3-beta.1](https://github.com/mi-examples/pp-dev/compare/v0.18.2...v0.18.3-beta.1) (2026-06-08)


### Bug Fixes

* **deps:** resolve npm audit findings across workspace ([bb41f5c](https://github.com/mi-examples/pp-dev/commit/bb41f5cec178d9db130cb5a51bbdabd0a42512dc))

## [0.18.2-beta.1](https://github.com/mi-examples/pp-dev/compare/v0.18.1...v0.18.2-beta.1) (2026-05-06)


### Bug Fixes

* **deps:** resolve npm audit findings across workspace ([d13ffad](https://github.com/mi-examples/pp-dev/commit/d13ffadcda69cf6f8c8de39c7b0f7d0840e6fa3a))

## [0.18.1-beta.2](https://github.com/mi-examples/pp-dev/compare/v0.18.1-beta.1...v0.18.1-beta.2) (2026-04-22)


### Bug Fixes

* harden sync prompt lifecycle and metadata safety ([3aaaeb6](https://github.com/mi-examples/pp-dev/commit/3aaaeb6a2a706f7f2ba6639c5ce87a320626eb32))

## [0.18.1-beta.1](https://github.com/mi-examples/pp-dev/compare/v0.18.0...v0.18.1-beta.1) (2026-04-21)


### Bug Fixes

* **cli:** harden shortcut cleanup and add dts trace logging ([4de05ed](https://github.com/mi-examples/pp-dev/commit/4de05ed2469933007aa654e370a84d90aecf3df3))

# [0.18.0-beta.1](https://github.com/mi-examples/pp-dev/compare/v0.17.0...v0.18.0-beta.1) (2026-04-06)

### Features

- rewrite /data/page/ path for v7 proxy when template differs from internal name ([a060da2](https://github.com/mi-examples/pp-dev/commit/a060da26e4d4cb9e80625f2015e5ab19b82a398d))

# [0.17.0-beta.1](https://github.com/mi-examples/pp-dev/compare/v0.16.1...v0.17.0-beta.1) (2026-04-06)

### Bug Fixes

- **tests:** align sandbox overrides with audited dependency policy ([5841aa8](https://github.com/mi-examples/pp-dev/commit/5841aa831833d74342e9bc134141f9913c1c0bab))

### Features

- **cli:** Webpack fallback for Next dev when Turbopack native SWC fails ([5940f31](https://github.com/mi-examples/pp-dev/commit/5940f316cf86056196ad3f69a8b3667460866aeb))

# [0.16.0-beta.1](https://github.com/mi-examples/pp-dev/compare/v0.15.1...v0.16.0-beta.1) (2026-03-23)

### Bug Fixes

- **version-plugin:** hash concatenated digests without hex input encoding ([1ea5e5a](https://github.com/mi-examples/pp-dev/commit/1ea5e5aed6b78b3bd67110d173a5195b75434e9c))

### Features

- version manifest plugin and upgrade to Vite 8 ([ad8c4ac](https://github.com/mi-examples/pp-dev/commit/ad8c4ac5b6bc7813d04947b418a5d3b77d2d75fb))

## [0.15.1-beta.1](https://github.com/mi-examples/pp-dev/compare/v0.15.0...v0.15.1-beta.1) (2026-03-12)

### Bug Fixes

- resolve all package vulnerabilities ([79d7e24](https://github.com/mi-examples/pp-dev/commit/79d7e245b94d0be8c133803842329309f0e1b432))

# [0.15.0-beta.2](https://github.com/mi-examples/pp-dev/compare/v0.15.0-beta.1...v0.15.0-beta.2) (2026-03-02)

### Bug Fixes

- add overrides to fix serialize-javascript and minimatch vulnerabilities ([3f79b97](https://github.com/mi-examples/pp-dev/commit/3f79b970b604f8e5656d15f743f51c6902b2e0d5))

# [0.15.0-beta.1](https://github.com/mi-examples/pp-dev/compare/v0.14.1...v0.15.0-beta.1) (2026-02-27)

### Bug Fixes

- add chokidar override to resolve npm ci sync ([3e24d40](https://github.com/mi-examples/pp-dev/commit/3e24d4020a33a5693f8aa442a0add6e80208719b))
- pass appId to initLoadPPData, remove debug logs, update lock file ([079c13b](https://github.com/mi-examples/pp-dev/commit/079c13bc3db2ea018d377ed01240ff7ffaea253d))
- proxy middleware - add cache headers for login page, inject token for HTML ([452755f](https://github.com/mi-examples/pp-dev/commit/452755f73391a0a6e2e19223db8f703219f6d993))

### Features

- add appId option and fix internal server restart ([ee74beb](https://github.com/mi-examples/pp-dev/commit/ee74beb07d0ffe091302c7af4b56b090ea5cb383))

## [0.14.1-beta.1](https://github.com/mi-examples/pp-dev/compare/v0.14.0...v0.14.1-beta.1) (2026-02-24)

### Bug Fixes

- **nextjs:** rewrite response middleware for Next.js page URLs ([3e80f41](https://github.com/mi-examples/pp-dev/commit/3e80f413c3106d9be918604ae0a5e28eeafc98d5))

# [0.14.0-beta.1](https://github.com/mi-examples/pp-dev/compare/v0.13.2...v0.14.0-beta.1) (2026-02-20)

### Bug Fixes

- ejs v4 default import for ESM compatibility ([e64f4c8](https://github.com/mi-examples/pp-dev/commit/e64f4c8fe1344a00daf575521215b0f82ec539ee))
- improve dev server restart reliability and config change detection ([3edd020](https://github.com/mi-examples/pp-dev/commit/3edd0206ab5d9e27e8088a8a55fc925f5a586f7f))

### Features

- **cli:** appId support, base path handling ([63ec031](https://github.com/mi-examples/pp-dev/commit/63ec0318a18a14b06803a59e8ac2d4be225d4631))
- **cli:** appId support, base path handling, API routes passthrough ([2c16dae](https://github.com/mi-examples/pp-dev/commit/2c16daea94e11d72a0ce93be0f40ed9f29eb4d6a))

## [0.13.2-beta.1](https://github.com/mi-examples/pp-dev/compare/v0.13.1...v0.13.2-beta.1) (2026-02-12)

### Bug Fixes

- **client-injection:** resolve DIRNAME to parent directory for correct resource paths ([606fd91](https://github.com/mi-examples/pp-dev/commit/606fd919ffda4988f4e1a0c11ce805cacfd75f1e))

# [0.13.0-beta.2](https://github.com/mi-examples/pp-dev/compare/v0.13.0-beta.1...v0.13.0-beta.2) (2026-02-11)

### Bug Fixes

- **plugin:** correct DIRNAME path resolution in client injection ([dce83d7](https://github.com/mi-examples/pp-dev/commit/dce83d78e987e0555060552a51bf6d1d32154853))

### Features

- **cli:** support Next.js 16 and fix base path regex escaping ([9182d2a](https://github.com/mi-examples/pp-dev/commit/9182d2a1d319239abf1b7b61cd40f03bbdf312fd))
- **cli:** watch .env and pp-dev config files, await Next.js check ([69a07f0](https://github.com/mi-examples/pp-dev/commit/69a07f0cbf0d3613fd1e6cdbf892cf0905005b51))

# [0.13.0-beta.1](https://github.com/mi-examples/pp-dev/compare/v0.12.4...v0.13.0-beta.1) (2026-01-22)

### Bug Fixes

- **plugin:** add null check for integrateMiTopBar validation ([df35e2a](https://github.com/mi-examples/pp-dev/commit/df35e2a8a265bd4a6445ec78c9ae94d4c24f105d))

### Features

- **plugin:** enhance integrateMiTopBar with selective configuration options ([cbb9a6c](https://github.com/mi-examples/pp-dev/commit/cbb9a6c59db401201fb2530f46ca47eaaa585526))

## [0.12.4-beta.1](https://github.com/mi-examples/pp-dev/compare/v0.12.3...v0.12.4-beta.1) (2026-01-14)

### Bug Fixes

- **plugin:** move topbar scripts injection to head-prepend ([a248f91](https://github.com/mi-examples/pp-dev/commit/a248f91b14817a36a37d56e9107762b514bf90ac))

# [@metricinsights/pp-dev-v0.12.3-beta.1](https://github.com/mi-examples/pp-dev-js/compare/v0.12.2...v0.12.3-beta.1) (2025-12-19)

### Bug Fixes

- **pp-dev:** improve node compatibility for SSL and buffer handling ([fcef21f](https://github.com/mi-examples/pp-dev-js/commit/fcef21f22936aeabb3a4c40711a76631246e80b4))

# [@metricinsights/pp-dev-v0.12.2](https://github.com/mi-examples/pp-dev-js/compare/v0.12.1...v0.12.2) (2025-01-15)

### Bug Fixes

- **release:** prepare v0.12.2 patch release

# [@metricinsights/pp-dev-v0.12.1](https://github.com/mi-examples/pp-dev-js/compare/v0.12.0...v0.12.1) (2025-01-15)

### Bug Fixes

- **release:** prepare v0.12.1 patch release

# [@metricinsights/pp-dev-v0.12.0](https://github.com/mi-examples/pp-dev-js/compare/v0.11.0...v0.12.0) (2025-01-15)

### Features

- **auth:** add global authentication provider ([2b1e00d](https://github.com/mi-examples/pp-dev-js/commit/2b1e00d20cbfd21284aa871c47bc149829a2f865))
- **pp-dev:** enhance CLI and core functionality ([14a3772](https://github.com/mi-examples/pp-dev-js/commit/14a3772a4955aabad6b0fa0986a7047445e0cc5b))

# [@metricinsights/pp-dev-v0.11.0-beta.4](https://github.com/mi-examples/pp-dev-js/compare/v0.11.0-beta.3...v0.11.0-beta.4) (2025-08-29)

### Features

- **pp-dev:** add postbuild script and package renaming utility ([afdc0d6](https://github.com/mi-examples/pp-dev-js/commit/afdc0d6aefd4545b536090c363dad21308683777))
- **pp-dev:** refactor CLI and core functionality ([98ce2d2](https://github.com/mi-examples/pp-dev-js/commit/98ce2d282abc83759b96b76e3502a0db99835404))
- **test-commonjs:** moved test commonjs folder to new location ([9480d77](https://github.com/mi-examples/pp-dev-js/commit/9480d77d9dfc5ccafb0f4b0159fedd484143d754))
- **test-nextjs:** add initial Next.js project files and configuration ([a5da0fd](https://github.com/mi-examples/pp-dev-js/commit/a5da0fdb5ab6f50b9605663706e88f62300aaea3))
- **test-nextjs:** initialize Next.js test project structure ([2a6155d](https://github.com/mi-examples/pp-dev-js/commit/2a6155dc94f3b27a7b9c3535d5e8699fc9da655c))

# [@metricinsights/pp-dev-v0.11.0-beta.3](https://github.com/mi-examples/pp-dev-js/compare/v0.11.0-beta.2...v0.11.0-beta.3) (2025-08-14)

### Bug Fixes

- **ci:** improve package detection and JSON validation ([f787a1c](https://github.com/mi-examples/pp-dev-js/commit/f787a1c2bf47c091c275d09317745b924c45f53f))

### Features

- **pp-dev:** add startup optimization and enhance authentication helpers ([a29e311](https://github.com/mi-examples/pp-dev-js/commit/a29e31136e0c27d221fc26028fd5c4970654e386))

# [@metricinsights/pp-dev-v0.11.0-beta.2](https://github.com/mi-examples/pp-dev-js/compare/v0.11.0-beta.1...v0.11.0-beta.2) (2025-08-12)

### Bug Fixes

- remove issue number references from semantic-release configs ([f532226](https://github.com/mi-examples/pp-dev-js/commit/f532226b1ecc4cf9d2cfac6e92cb1c101468a329))

# [@metricinsights/pp-dev-v0.11.0-beta.1](https://github.com/mi-examples/pp-dev-js/compare/v0.10.1...v0.11.0-beta.1) (2025-08-12)

### Features

- **pp-dev:** add dependency version synchronization for create-pp-dev releases ([2597b01](https://github.com/mi-examples/pp-dev-js/commit/2597b017a59b1359753e85953648e2ce1674253c))
- **pp-dev:** add esbuild configuration and build optimization scripts ([bbe1791](https://github.com/mi-examples/pp-dev-js/commit/bbe1791e9eb2e220f1552618a9a534a80ddd2f96))
- **pp-dev:** add semantic release configuration and update dependencies ([5962bcc](https://github.com/mi-examples/pp-dev-js/commit/5962bccbb76fb684415f731f85f372cdd109d8f1))

# Changelog

All notable changes to the `@metricinsights/pp-dev` package will be documented in this file.

## [0.10.0] - 2024-03-21

### Changed

- Removed unused `pino` and `pino-pretty` dependencies

## [0.9.0] - 2025-01-31

### Added

- Added support for MI v7.1.0 instances
- Added new API endpoints for v7 instances

## [0.8.0] - 2024-11-15

### Changed

- Updated package dependencies to latest versions
- Improved template loading mechanism

## [0.7.0] - 2024-02-28

### Added

- Added icon font generation tool
- Added changelog generator for assets
- Added image optimization tool

### Changed

- Improved helper logging system

## [0.6.0] - 2024-01-18

### Added

- Added support for React.js, TypeScript, and Next.js templates
- Added new npm package structure
- Added documentation for templates

### Changed

- Updated template code structure
- Improved helper info panel

## [0.5.0] - 2023-10-16

### Added

- Added Next.js support (beta)
- Added SSL validation support
- Added shields for package information

### Changed

- Fixed Next.js dependency versions
- Improved helper UI

## [0.4.0] - 2023-05-29

### Added

- Added CI/CD support
- Added package for CI/CD
- Added documentation

### Changed

- Updated publish configuration
- Improved installation command

## [0.3.3] - 2023-11-14

### Changed

- Fixed URL parameters handling in helper
- Improved helper UI

## [0.3.2] - 2023-11-14

### Changed

- Fixed Next.js dependency versions
- Improved helper UI

## [0.3.1] - 2023-12-04

### Changed

- Fixed URL parameters handling in helper
- Improved helper UI

## [0.3.0] - 2023-11-08

### Added

- Added Next.js support
- Added helper info panel
- Added support for React.js templates

### Changed

- Improved helper UI
- Updated template loading mechanism

## [0.2.0] - 2023-05-25

### Added

- Added support for React.js templates
- Added helper info panel
- Added documentation

### Changed

- Improved template loading mechanism
- Updated package structure

## [0.1.1] - 2023-05-23

### Changed

- Fixed template loading issues
- Improved helper UI

## [0.1.0] - 2023-05-17

### Added

- Initial release
- Basic template support
- Helper UI implementation

## [0.0.3] - 2023-05-17

### Added

- Added basic template support
- Added helper UI

### Changed

- Improved package structure

## [0.0.2] - 2023-05-17

### Added

- Added basic package structure
- Added helper implementation

## [0.0.1] - 2023-05-17

### Added

- Initial package setup
- Basic helper functionality
