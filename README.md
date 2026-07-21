# pp-dev

<p align="center">
   <a href="https://www.npmjs.com/package/@metricinsights/pp-dev"><img alt="npm" src="https://img.shields.io/npm/v/%40metricinsights%2Fpp-dev?logo=npm&label=npm%20package"></a>
   <a href="https://github.com/mi-examples/pp-dev/releases"><img alt="Release" src="https://img.shields.io/github/v/release/mi-examples/pp-dev?label=release"></a>
   <a href="https://github.com/mi-examples/pp-dev/actions/workflows/ci.yml"><img alt="GitHub Workflow CI Status (with event)" src="https://github.com/mi-examples/pp-dev/actions/workflows/ci.yml/badge.svg?branch=develop"></a>
</p>

The PP Dev Helper is a development framework and build tool for Metric Insights' Portal Pages, designed to make the
lives of PP developers easier:

- Build and test Portal Pages locally
- Proxy API requests to a Metric Insights server
- Hot module replacement for faster development
- Image optimization and asset management
- Template variable transformation
- Code synchronization with Metric Insights instances

pp-dev is based on [Vite](https://vitejs.dev/).

## Installation

```bash
npm install @metricinsights/pp-dev
```

### Peer Dependencies

This package requires Next.js as a peer dependency for certain functionality:

```bash
npm install next@^15
```

**Note**: pp-dev requires Next.js version 15 or higher (but less than 17) to be installed in your project. This is a peer dependency, meaning it won't be automatically installed with pp-dev.

## Package Structure

The pp-dev package provides multiple entry points for different use cases:

```javascript
// Main package (includes everything)
import ppDev from '@metricinsights/pp-dev';

// Plugin only (for Vite integration)
import { vitePPDev } from '@metricinsights/pp-dev/plugin';

// Helpers only (defineConfig and utility functions)
import { defineConfig } from '@metricinsights/pp-dev/helpers';

// Client assets (for development UI)
import '@metricinsights/pp-dev/client/css/client.css';
```

## Configuration

### Configuration File

Create a configuration file named `pp-dev.config` with one of these extensions:

- `.ts` (recommended)
- `.js` or `.cjs` (for CommonJS)
- `.json`

Alternatively, you can define configuration in your `package.json` using the `pp-dev` key.

### Configuration Examples

#### TypeScript (recommended)

```typescript
// pp-dev.config.ts
import { defineConfig } from '@metricinsights/pp-dev';

export default defineConfig({
  mi: {
    url: 'https://mi.company.com',
    token: process.env.MI_ACCESS_TOKEN,
    mode: 'standalone',
    apiVersion: 7,
  },
  app: {
    id: 123,
    type: 'template',
  },
});
```

#### JavaScript (CommonJS)

```javascript
// pp-dev.config.js
const { defineConfig } = require('@metricinsights/pp-dev');

module.exports = defineConfig({
  mi: {
    url: 'https://mi.company.com',
    mode: 'standalone',
    apiVersion: 7,
  },
  app: {
    id: 123,
    type: 'template',
  },
});
```

#### JSON

```json
{
  "mi": {
    "url": "https://mi.company.com",
    "mode": "standalone",
    "apiVersion": 7
  },
  "app": {
    "id": 123,
    "type": "template"
  }
}
```

#### package.json

```json
{
  "name": "my-portal-page",
  "pp-dev": {
    "mi": {
      "url": "https://mi.company.com",
      "mode": "standalone"
    },
    "app": {
      "id": 123
    }
  }
}
```

## Configuration Options

### `mi` — Metric Insights connection

| Field        | Type                              | Default        | Description                                               |
|--------------|-----------------------------------|----------------|-----------------------------------------------------------|
| `url`        | `string`                          | —              | URL of the Metric Insights instance                       |
| `token`      | `string`                          | `MI_ACCESS_TOKEN` env | Personal access token for authentication           |
| `mode`       | `'standalone' \| 'embedding'`     | `'standalone'` | Standalone hides the MI navigation; embedding keeps it    |
| `include`    | `'top-bar' \| 'shared-components'`| —              | Bundle MI top-bar assets into the build (requires `standalone`) |
| `apiVersion` | `6 \| 7`                          | `7`            | MI API version to target                                  |

### `app` — Portal Page identity

| Field  | Type                       | Default                  | Description                                                 |
|--------|----------------------------|--------------------------|-------------------------------------------------------------|
| `id`   | `number`                   | —                        | Portal Page ID used to fetch template variables             |
| `type` | `'template' \| 'page'`     | `'template'`             | `template` syncs back to MI; `page` is standalone-only      |
| `name` | `string`                   | `package.json#name`      | Template name on the MI instance (usually auto-resolved)    |

### `proxy` — Request proxying

| Field               | Type      | Default  | Description                                          |
|---------------------|-----------|----------|------------------------------------------------------|
| `cache`             | `boolean` | `true`   | Enable caching of proxied requests                   |
| `cacheTtl`          | `number`  | `600000` | Cache TTL in milliseconds (10 minutes)               |
| `tls.allowSelfSigned` | `boolean` | `false` | Allow self-signed SSL certificates on the MI server |

### `build` — Build output

| Field               | Type                                                        | Default  | Description                                                                          |
|---------------------|-------------------------------------------------------------|----------|--------------------------------------------------------------------------------------|
| `outDir`            | `string`                                                    | `'dist'` | Output directory                                                                     |
| `zip`               | `boolean \| { fileName?: string; outDir?: string; inDir?: string }` | `true` | Zip build output. Object form customizes filename and directories.        |
| `versionFile`       | `boolean \| { enabled?: boolean; fileNameTemplate?: string }` | `true` | Write a VERSION file into the build                                                  |
| `imageOptimisations`| `boolean \| Record<string, unknown>`                        | `true`   | Image optimization. See [vite-plugin-image-optimizer](https://www.npmjs.com/package/vite-plugin-image-optimizer#plugin-options) for object options |

### `inspector` — Request Inspector

| Field          | Type      | Default     | Description                                                    |
|----------------|-----------|-------------|----------------------------------------------------------------|
| `enabled`      | `boolean` | `true`      | Enable the request inspector                                   |
| `maxMemory`    | `number`  | `104857600` | Max total body memory (bytes) before oldest entries are evicted (default 100 MB) |
| `captureLimit` | `number`  | `10485760`  | Max body size captured per request/response (bytes, default 10 MB). Larger bodies are stored truncated. |

### `sync` — Template sync

| Field        | Type     | Default     | Description                             |
|--------------|----------|-------------|-----------------------------------------|
| `backupsDir` | `string` | `'backups'` | Directory for backups from the MI server |

### `devPanel` — Dev panel appearance

| Field      | Type                                                            | Default          | Description                                                                 |
|------------|-----------------------------------------------------------------|------------------|-----------------------------------------------------------------------------|
| `position` | `'top-left' \| 'top-right' \| 'bottom-left' \| 'bottom-right'`  | `'bottom-right'` | Screen corner the dev panel is anchored to                                  |
| `hidden`   | `boolean`                                                       | `false`          | Fully hide the panel. Restore in the browser with `?pp-dev-panel=show`      |
| `autoHide` | `boolean`                                                       | `false`          | Panel slides behind the screen edge leaving a thin strip; hover reveals it  |

These values are **defaults**: the panel itself has a settings popover (gear icon) with a corner
picker, an auto-hide toggle and a hide button, and the panel can be dragged by its grip handle and
snapped to any corner. Runtime choices are persisted in the browser's `localStorage`
(`pp-dev-info-position`, `pp-dev-info-auto-hide`, `pp-dev-info-hidden`) and take precedence over
the config until "Reset to config defaults" is clicked in the popover. The URL params
`?pp-dev-panel=show` / `?pp-dev-panel=hide` set a persistent override too — handy for restoring a
hidden panel or taking clean screenshots. Note that `localStorage` is origin-scoped, so overrides
apply to every pp-dev app served on the same host and port. See the [Dev Panel](#dev-panel)
section for the full feature description.

### Validation

pp-dev validates your config at startup and reports problems clearly:

| Condition | Behaviour |
|---|---|
| `mi.include` set + `mi.mode !== 'standalone'` | error |
| `mi.url` missing + `mi.mode === 'embedding'` or `app.type === 'template'` | error |
| `mi.url` missing + `mi.mode === 'standalone'` + `app.type === 'page'` | warning |
| `app.type === 'template'` without `app.id` | error |
| `app.type === 'page'` + `mi.mode === 'standalone'` without `app.id` | error |
| `app.name` missing and no `package.json#name` | error |
| `devPanel.position` not one of the four corners | error |

### Environment Variables

| Variable                        | Description                                                                        |
|----------------------------------|-------------------------------------------------------------------------------------|
| `MI_ACCESS_TOKEN`                | Default value for `mi.token` when not set in config                                 |
| `PP_DEV_DIST_ZIP`                | `true`/`false` — override `build.zip` for `pp-dev build` / `pp-dev next-build`       |
| `PP_DEV_DIST_ZIP_DIR`            | Override the ZIP output directory (`build.zip.outDir`)                              |
| `PP_DEV_DIST_ZIP_FILENAME`       | Override the ZIP file name (`build.zip.fileName`)                                   |
| `PP_DEV_VERSION_MANIFEST`        | `true`/`false` — override `build.versionFile` (VERSION/BUILD-MANIFEST generation)    |
| `PP_DEV_VERSION_FILE_TEMPLATE`   | Override the VERSION file name template                                             |

The `PP_DEV_DIST_ZIP*`/`PP_DEV_VERSION_*` variables are read by `pp-dev build` and
`pp-dev next-build`; an equivalent CLI flag always takes precedence over its env var. See
[Build](#build) / [Next.js Build](#nextjs-build).

**Local development and network exposure**: pp-dev is a **development** tool. It assumes a trusted machine. Personal access tokens and session helpers are still sensitive: they can authenticate to your Metric Insights backend as you.

- Prefer binding the dev server to **`localhost`** when you do not need access from other devices. If you use **`--host`** (or equivalent) so the app listens on **all interfaces** or your LAN, other machines on the same network can reach the dev server and its dev-only routes. Treat that like exposing credentials: use only on networks you trust, or restrict access with your OS firewall.
- Do not commit real tokens; keep them in `.env` (gitignored) or your secret store.

## Migrating from 0.x

Run the built-in codemod to upgrade your config automatically:

```bash
npx @metricinsights/pp-dev migrate
```

Options:

| Option | Description |
|---|---|
| `[config]` | Path to config file (auto-detected if omitted) |
| `--dry-run` | Preview the migrated output without writing |
| `--format ts\|js\|json` | Override output format |
| `--output <file>` | Write to a specific file instead of overwriting |
| `--no-backup` | Skip creating a `.bak` backup of the original |

The command detects flat 0.x configs and legacy `pp-watch.config.*` files, converts them to the new grouped format, and writes a `.bak` backup before overwriting.

**Field mapping** (0.x → 1.0):

| 0.x | 1.0 |
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
| `templateName` | `app.name` (usually omit — auto-resolved from `package.json#name`) |
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

## CLI Commands

### Global Options

| Option                   | Description                                                                      |
| ------------------------ | -------------------------------------------------------------------------------- |
| `-c, --config <file>`    | Path to configuration file (default: `pp-dev.config.js`)                         |
| `--base <path>`          | Public base path (default: `/`)                                                  |
| `-l, --logLevel <level>` | Log level: `trace`, `debug`, `info`, `warn`, `error`, `silent` (default: `info`) |
| `--clearScreen`          | Clear screen before logging                                                      |
| `--mode <mode>`          | Environment mode: `development`, `production`, `test` (default: `development`)   |

### Development Server

```bash
pp-dev [root] [options]
# Aliases: pp-dev dev, pp-dev serve
```

| Option          | Default     | Description                       |
| --------------- | ----------- | --------------------------------- |
| `[root]`        | `.`         | Root directory of the application |
| `--host <host>` | `localhost` | Server hostname                   |
| `--port <port>` | `3000`      | Server port                       |
| `--open [path]` | -           | Open browser on server start      |
| `--strictPort`  | -           | Exit if port is already in use    |

**Development Shortcuts**:

- `l` - Proxy re-login (refresh authentication)
- `r` - Restart dev server
- `u` - Show server URLs
- `q` - Quit dev server

### Next.js Development

```bash
pp-dev next [options]
# Aliases: pp-dev next-server, pp-dev next-dev
```

| Option          | Default     | Description                       |
| --------------- | ----------- | --------------------------------- |
| `[root]`        | `.`         | Root directory of the application |
| `--port <port>` | `3000`      | Server port                       |
| `--host <host>` | `localhost` | Server hostname                   |

### Build

```bash
pp-dev build [options]
```

| Option                          | Default   | Description                                            |
| ------------------------------- | --------- | ------------------------------------------------------ |
| `[root]`                        | `.`       | Root directory of the application                      |
| `--target <target>`             | `modules` | Transpile target                                       |
| `--outDir <dir>`                | `dist`    | Output directory                                       |
| `--assetsDir <dir>`             | `assets`  | Assets directory under outDir                          |
| `--changelog [file]`            | `true`    | Create changelog file                                  |
| `--distZip` / `--no-distZip`    | see below | Override `build.zip` — pack (or skip) the output ZIP   |
| `--distZipDir <dir>`            | see below | Override the ZIP output directory (`build.zip.outDir`) |
| `--distZipFilename <file>`      | see below | Override the ZIP file name (`build.zip.fileName`)      |
| `--versionManifest` / `--no-versionManifest` | see below | Override `build.versionFile` — emit (or skip) VERSION/BUILD-MANIFEST |
| `--versionFileTemplate <tpl>`   | see below | Override the VERSION file name template                |

The `--distZip*`/`--versionManifest*` flags (and their `PP_DEV_*` env var equivalents, see
[Environment Variables](#environment-variables)) let CI or ad-hoc builds override the `build.zip`
and `build.versionFile` config without editing `pp-dev.config`. Precedence: CLI flag > env var >
config file > built-in default. The same flags are available on `pp-dev next-build` (below).

### Next.js Build

```bash
pp-dev next-build [options]
```

Plain `next build` only produces the Next.js static export — no VERSION file, BUILD-MANIFEST, or
ZIP archive. `pp-dev next-build` runs `next build` and then applies the same post-build steps as
`pp-dev build`, so Next.js and Vite templates produce build artifacts in the same format:

1. Runs `next build` (requires `output: 'export'` in `next.config`)
2. Writes `VERSION-*.json` + `BUILD-MANIFEST.json` into the export directory (`build.versionFile`)
3. Zips the export directory into `dist-zip/<name>.zip` (`build.zip`)

Use it in place of `next build` in your `package.json`:

```json
{
  "scripts": {
    "build": "pp-dev next-build --changelog"
  }
}
```

| Option                          | Default   | Description                                            |
| ------------------------------- | --------- | ------------------------------------------------------ |
| `[root]`                        | `.`       | Root directory of the application                      |
| `--changelog [file]`            | `true`    | Create changelog file                                  |
| `--distZip` / `--no-distZip`    | see below | Override `build.zip` — pack (or skip) the output ZIP   |
| `--distZipDir <dir>`            | see below | Override the ZIP output directory (`build.zip.outDir`) |
| `--distZipFilename <file>`      | see below | Override the ZIP file name (`build.zip.fileName`)      |
| `--versionManifest` / `--no-versionManifest` | see below | Override `build.versionFile` — emit (or skip) VERSION/BUILD-MANIFEST |
| `--versionFileTemplate <tpl>`   | see below | Override the VERSION file name template                |

### Migration

```bash
pp-dev migrate [config] [options]
```

| Option | Description |
|---|---|
| `[config]` | Config file to migrate (auto-detected if omitted) |
| `--dry-run` | Preview output without writing |
| `--format ts\|js\|json` | Output format |
| `--output <file>` | Write to a specific path |
| `--no-backup` | Skip `.bak` backup |

### Changelog Generation

```bash
pp-dev changelog [oldAssetPath] [newAssetPath] [options]
```

| Option                   | Default          | Description                |
| ------------------------ | ---------------- | -------------------------- |
| `[oldAssetPath]`         | -                | Path to previous assets    |
| `[newAssetPath]`         | -                | Path to current assets     |
| `--oldAssetsPath <path>` | -                | Path to previous assets    |
| `--newAssetsPath <path>` | -                | Path to current assets     |
| `--destination <path>`   | `.`              | Changelog output directory |
| `--filename <name>`      | `CHANGELOG.html` | Changelog filename         |

### Icon Font Generation

```bash
pp-dev generate-icon-font [source] [destination] [options]
```

| Option                 | Default     | Description                     |
| ---------------------- | ----------- | ------------------------------- |
| `[source]`             | -           | Source directory with SVG icons |
| `[destination]`        | -           | Output directory                |
| `--source <path>`      | -           | Source directory with SVG icons |
| `--destination <path>` | -           | Output directory                |
| `--fontName <name>`    | `icon-font` | Font name                       |

## Next.js Integration

1. Add a `pp-dev.config.ts` to your project root
2. Update `package.json` scripts:
   ```json
   {
     "scripts": {
       "dev": "pp-dev next",
       "build": "pp-dev next-build"
     }
   }
   ```
   `pp-dev next-build` replaces a plain `next build` so the Next.js template produces the same
   VERSION/BUILD-MANIFEST/ZIP artifacts as `pp-dev build` — see [Next.js Build](#nextjs-build).
3. Wrap your Next.js config:

```javascript
// next.config.js
const { withPPDev } = require('@metricinsights/pp-dev');

module.exports = withPPDev({
  // your Next.js config
});
```

## Vite Configuration

For custom build configuration, create a `vite.config` file. See [Vite Configuration](https://vitejs.dev/config/) for details.

## Dev Panel

pp-dev injects a floating dev panel into every served page. It shows the package name and version, the backend URL, the template mode and the App ID, and hosts the template **Sync** button. Since 1.0 the panel is fully repositionable and can be hidden.

### Position

The panel can be anchored to any of the four screen corners (default: bottom-right). Three ways to move it:

- **Drag & snap** — grab the grip handle (six dots on the panel's left side) and drag; on release the panel snaps to the nearest corner. Dragging works across iframes and is cancelled with <kbd>Escape</kbd>.
- **Settings popover** — click the gear icon and pick a corner in the 2×2 grid.
- **Config default** — set `devPanel.position` in `pp-dev.config` (see below).

The minimize arrow, the panel's shadow, rounded corner and slide direction all mirror automatically for left/top placements. Sync notification popups stack from the screen edge opposite the panel so they never cover it.

### Auto-hide

Toggle **Auto-hide** in the settings popover (or set `devPanel.autoHide: true`). The panel slides behind the nearest screen edge leaving a 4px accent strip; hovering the strip for ~300 ms slides it out, and it hides again ~500 ms after the pointer leaves. Keyboard focus inside the panel keeps it revealed. While auto-hide is active the minimize arrow acts as a **pin** button that returns the panel to normal mode.

### Hiding and restoring

**Hide panel** in the settings popover (or `devPanel.hidden: true`) removes the panel from view entirely. To bring it back, open any page with `?pp-dev-panel=show` in the URL — the override persists across reloads. The symmetric `?pp-dev-panel=hide` hides it, which is handy for demos and clean screenshots.

### State persistence

Runtime choices are saved in the browser's `localStorage` (`pp-dev-info-position`, `pp-dev-info-auto-hide`, `pp-dev-info-hidden`) and take precedence over config values. **Reset to config defaults** in the settings popover clears all overrides. Storage is origin-scoped: overrides apply to every pp-dev app served on the same host and port, and a Metric Insights page that clears origin storage will reset them to config defaults.

### Configuration

```typescript
// pp-dev.config.ts
export default defineConfig({
  devPanel: {
    position: 'bottom-right', // 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
    hidden: false,            // hide the panel entirely (restore with ?pp-dev-panel=show)
    autoHide: false,          // slide behind the screen edge, reveal on hover
  },
});
```

See the [`devPanel` option reference](#devpanel--dev-panel-appearance) for details.

## Request Inspector

pp-dev includes a built-in request inspector that captures every proxied and locally-served HTTP request made during development. It is enabled by default.

### Web UI

Open `http://localhost:3000/@pp-dev/inspector` (replace port as needed) in any browser tab while the dev server is running. The UI shows:

- A scrollable list of captured requests with method, status, source badge, and timing
- Full request and response headers, with a **Copy** button per section
- Request and response bodies rendered as text for JSON/HTML/CSS/plain-text content types, with **Copy** and **Save** buttons
- Binary bodies (images, fonts, archives) show metadata only and offer a **Save** button
- A **Clear** button in the top-right removes all stored entries

### Source badges

Each request in the list displays a colored letter badge to the left of the HTTP status:

| Badge | Color  | Meaning                                      |
|-------|--------|----------------------------------------------|
| `P`   | Purple | Forwarded to the upstream Metric Insights server (proxy) |
| `C`   | Amber  | Served from the local proxy cache             |
| `L`   | Grey   | Served locally (static file, dev route, etc.) |

### Console banner

The dev panel script prints a one-line banner to the browser DevTools console when the page loads:

```
pp-dev  🔍 Request Inspector  →  http://localhost:3000/@pp-dev/inspector
```

The message persists in DevTools history so it is visible even when you open the console after the page has loaded.

### REST API

The inspector also exposes a lightweight JSON API, useful for tooling and AI agents:

| Method   | Path                    | Description                                 |
|----------|-------------------------|---------------------------------------------|
| `GET`    | `/@api/requests`        | Paginated list of captured requests (metadata only, no bodies) |
| `GET`    | `/@api/requests/:id`    | Full entry including captured request/response bodies (base64-encoded) |
| `GET`    | `/@api/requests/stats`  | Store stats: entry count, memory usage, limits |
| `DELETE` | `/@api/requests`        | Clear all stored entries                    |

`GET /@api/requests` accepts `?limit=` (default 50) and `?offset=` query parameters for pagination.

Bodies in `GET /@api/requests/:id` are returned as base64 strings in `requestBody` / `responseBody` fields alongside `requestContentType` / `responseContentType`. A `*Truncated: true` flag indicates the body exceeded `captureLimit` and was cut off.

### Configuration

```typescript
// pp-dev.config.ts
export default defineConfig({
  inspector: {
    enabled: true,         // set to false to disable entirely
    maxMemory: 100 * 1024 * 1024,   // evict oldest entries above 100 MB
    captureLimit: 10 * 1024 * 1024, // capture at most 10 MB per body
  },
});
```

## Troubleshooting

### Common Issues

#### Next.js Peer Dependency Error

If you encounter an error like "Next.js is required but not available":

1. **Install Next.js in your project:**

   ```bash
   npm install next@^15
   ```

2. **Verify the installation:**

   ```bash
   npm list next
   ```

3. **Check your package.json:**
   ```json
   {
     "dependencies": {
       "next": "^15.0.0"
     }
   }
   ```

#### Version Compatibility

- **pp-dev** requires Next.js version 15 or higher (but less than 17)
- **Node.js** version 24 or higher is required
- **TypeScript** version 5 or higher is recommended

### Getting Help

- Check the [GitHub Issues](https://github.com/mi-examples/pp-dev-js/issues) for known problems
- Review the [CHANGELOG.md](./CHANGELOG.md) for recent changes
- Ensure all peer dependencies are properly installed
