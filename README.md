# pp-dev

<p align="center">
   <a href="https://www.npmjs.com/package/@metricinsights/pp-dev"><img alt="npm" src="https://img.shields.io/npm/v/%40metricinsights%2Fpp-dev?logo=npm&label=npm%20package"></a>
   <a href="https://github.com/mi-examples/pp-dev-js/actions/workflows/publish.yml"><img alt="GitHub Workflow Status (with event)" src="https://img.shields.io/github/actions/workflow/status/mi-examples/pp-dev-js/publish.yml?logo=github"></a>
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

## Configuration

### Configuration File

Create a configuration file named `pp-dev.config` with one of these extensions:
- `.js` or `.cjs` (for CommonJS)
- `.ts` (for TypeScript)
- `.json`

Alternatively, you can define configuration in your `package.json` using the `pp-dev` key.

### Configuration Examples

#### JavaScript (CommonJS)

```javascript
// pp-dev.config.js

/**
 * @type {import('@metricinsights/pp-dev').PPDevConfig}
 */
module.exports = {
  backendBaseURL: 'https://mi.company.com',
  portalPageId: 1,
};
```

#### TypeScript

```typescript
// pp-dev.config.ts

import { PPDevConfig } from '@metricinsights/pp-dev';

const config: PPDevConfig = {
  backendBaseURL: 'https://mi.company.com',
  appId: 1,
  v7Features: true,
};

export default config;
```

#### JSON

```json
// pp-dev.config.json
{
  "backendBaseURL": "https://mi.company.com",
  "appId": 1,
  "v7Features": true
}
```

#### package.json

```json
{
  "name": "my-portal-page",
  "version": "1.0.0",
  "pp-dev": {
    "backendBaseURL": "https://mi.company.com",
    "appId": 1,
    "v7Features": true
  }
}
```

## Configuration Options

### Required Options

| Option | Type | Description |
|--------|------|-------------|
| `backendBaseURL` | string | URL of the Metric Insights instance for API proxying |
| `portalPageId` | number | ID of the Portal Page for variable values (deprecated, use `appId` instead) |
| `appId` | number | ID of the Portal Page for variable values (synonym for `portalPageId`) |

### Optional Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `miHudLess` | boolean | `false` | Disables Metric Insights navigation bar in development |
| `templateLess` | boolean | `false` | Disables template variable transformation |
| `enableProxyCache` | boolean | `true` | Enables caching of proxied requests |
| `proxyCacheTTL` | number | `600000` | Cache TTL in milliseconds (10 minutes) |
| `disableSSLValidation` | boolean | `false` | Disables SSL certificate validation for proxy requests |
| `imageOptimizer` | boolean \| object | `true` | Controls image optimization. See [vite-plugin-image-optimizer](https://www.npmjs.com/package/vite-plugin-image-optimizer#plugin-options) for object options |
| `outDir` | string | `dist` | Output directory for builds |
| `distZip` | boolean \| object | `true` | Controls build output zipping. Object options: `{ outDir?: string, outFileName?: string }` |
| `syncBackupsDir` | string | `backups` | Directory for asset backups from MI server |
| `v7Features` | boolean | `false` | Enables Metric Insights v7 features |
| `personalAccessToken` | string | `process.env.MI_ACCESS_TOKEN` | Personal Access Token for the MI instance |

### v7Features Details

When enabled (`true`), this option:
1. Changes development path from `/pt/<portal-page-name>` to `/pl/<portal-page-name>`
2. Updates Code Sync feature to use v7.1.0+ URLs

### Personal Access Token

The `personalAccessToken` option allows you to authenticate with the Metric Insights instance. You can set it in your configuration or use the `MI_ACCESS_TOKEN` environment variable.

Example:
```javascript
// pp-dev.config.js
module.exports = {
  backendBaseURL: 'https://mi.company.com',
  appId: 1,
  personalAccessToken: process.env.MI_ACCESS_TOKEN,
};
```

## CLI Commands

### Global Options

| Option | Description |
|--------|-------------|
| `-c, --config <file>` | Path to configuration file (default: `pp-dev.config.js`) |
| `--base <path>` | Public base path (default: `/`) |
| `-l, --logLevel <level>` | Log level: `trace`, `debug`, `info`, `warn`, `error`, `silent` (default: `info`) |
| `--clearScreen` | Clear screen before logging |
| `--mode <mode>` | Environment mode: `development`, `production`, `test` (default: `development`) |

### Development Server

```bash
pp-dev [root] [options]
# Aliases: pp-dev dev, pp-dev serve
```

| Option | Default | Description |
|--------|---------|-------------|
| `[root]` | `.` | Root directory of the application |
| `--host <host>` | `localhost` | Server hostname |
| `--port <port>` | `3000` | Server port |
| `--open [path]` | - | Open browser on server start |
| `--strictPort` | - | Exit if port is already in use |

### Next.js Development

```bash
pp-dev next [options]
# Aliases: pp-dev next-server, pp-dev next-dev
```

| Option | Default | Description |
|--------|---------|-------------|
| `[root]` | `.` | Root directory of the application |
| `--port <port>` | `3000` | Server port |
| `--host <host>` | `localhost` | Server hostname |

### Build

```bash
pp-dev build [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `[root]` | `.` | Root directory of the application |
| `--target <target>` | `modules` | Transpile target |
| `--outDir <dir>` | `dist` | Output directory |
| `--assetsDir <dir>` | `assets` | Assets directory under outDir |
| `--changelog [file]` | `true` | Create changelog file |

### Changelog Generation

```bash
pp-dev changelog [oldAssetPath] [newAssetPath] [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `[oldAssetPath]` | - | Path to previous assets |
| `[newAssetPath]` | - | Path to current assets |
| `--oldAssetsPath <path>` | - | Path to previous assets |
| `--newAssetsPath <path>` | - | Path to current assets |
| `--destination <path>` | `.` | Changelog output directory |
| `--filename <name>` | `CHANGELOG.html` | Changelog filename |

### Icon Font Generation

```bash
pp-dev generate-icon-font [source] [destination] [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `[source]` | - | Source directory with SVG icons |
| `[destination]` | - | Output directory |
| `--source <path>` | - | Source directory with SVG icons |
| `--destination <path>` | - | Output directory |
| `--fontName <name>` | `icon-font` | Font name |

## Next.js Integration

1. Add pp-dev configuration to your project root
2. Update `package.json` scripts:
   ```json
   {
     "scripts": {
       "dev": "pp-dev next"
     }
   }
   ```
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

