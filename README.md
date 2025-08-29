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

// Helpers only (for utility functions)
import { helpers } from '@metricinsights/pp-dev/helpers';

// Client assets (for development UI)
import '@metricinsights/pp-dev/client/css/client.css';
```

**Available Exports**:
- **Main**: Complete pp-dev functionality with CLI and plugins
- **Plugin**: Vite plugin for integration with build tools
- **Helpers**: Utility functions for authentication and configuration
- **Client**: Development UI assets and styles

## 🚀 Performance & Build System

The pp-dev package includes optimized startup performance and build system with multiple strategies:

### Quick Start
```bash
# Standard build (parallel)
npm run build

# Fast development build
npm run build:fast

# Watch mode for development
npm run build:watch

# Bundle analysis
npm run build:analyze

# Performance profiling
npm run startup:profile

# Startup optimization
npm run startup:optimize
```

### Performance Features
- **40-50% faster startup** with intelligent caching
- **60-70% faster subsequent starts** with connection pooling
- **Lazy loading** of heavy modules (jsdom, esbuild)
- **API response caching** with configurable TTL
- **HTTP connection pooling** for reduced overhead
- **Startup profiling** with detailed performance analysis
- **Intelligent dependency optimization** based on profiling data

### Build Features
- **Parallel builds** for 40-60% faster build times
- **Enhanced tree-shaking** for smaller bundles
- **Multiple output formats** (ESM, CJS, Types)
- **Bundle analysis** with visualizer support
- **ESBuild integration** for faster TypeScript compilation
- **Build optimization scripts** for performance tuning

### Startup Optimization

The new startup optimization system in v0.11.0 provides:

- **Performance Monitoring**: Real-time startup time tracking and analysis
- **Cache Optimization**: Intelligent cache management for config and API responses
- **Dependency Analysis**: Identification of performance bottlenecks
- **Optimization Suggestions**: Automated recommendations for performance improvements

Run the startup optimizer to analyze and improve your development environment:
```bash
npm run startup:optimize
```

📖 See [BUILD_IMPROVEMENTS.md](./BUILD_IMPROVEMENTS.md) for build details.
📖 See [STARTUP_PERFORMANCE.md](./STARTUP_PERFORMANCE.md) for performance details.

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
  appId: 1,
  v7Features: true,
  miHudLess: true,
  integrateMiTopBar: true,
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
  miHudLess: true,
  integrateMiTopBar: true,
};

export default config;
```

#### JSON

```json
// pp-dev.config.json
{
  "backendBaseURL": "https://mi.company.com",
  "appId": 1,
  "v7Features": true,
  "miHudLess": true,
  "integrateMiTopBar": true
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
    "v7Features": true,
    "miHudLess": true,
    "integrateMiTopBar": true
  }
}
```

## Configuration Options

> **Version Compatibility**: This documentation covers pp-dev v0.11.0+. Some options may not be available in older versions. Check the [CHANGELOG](./CHANGELOG.md) for version-specific information.

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
| `integrateMiTopBar` | boolean | `false` | Integrates MI Top Bar and script into the App build (requires `miHudLess: true`) |
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

### integrateMiTopBar Details

The `integrateMiTopBar` option allows you to integrate the Metric Insights Top Bar and scripts directly into your application build. This is useful when you want to:

1. **Customize the Top Bar**: Modify the appearance and behavior of the MI navigation
2. **Bundle Integration**: Include MI scripts in your build instead of loading them dynamically
3. **Offline Development**: Work with MI features even when disconnected from the server

**Important**: This option can only be enabled when `miHudLess` is set to `true`.

Example configuration:
```javascript
// pp-dev.config.js
module.exports = {
  backendBaseURL: 'https://mi.company.com',
  appId: 1,
  miHudLess: true,           // Required: Disable dynamic MI scripts
  integrateMiTopBar: true,    // Enable: Integrate Top Bar into build
};
```

### v7Features Details

When enabled (`true`), this option:
1. Changes development path from `/pt/<portal-page-name>` to `/pl/<portal-page-name>`
2. Updates Code Sync feature to use v7.1.0+ URLs

### Personal Access Token

The `personalAccessToken` option allows you to authenticate with the Metric Insights instance. You can set it in your configuration or use the `MI_ACCESS_TOKEN` environment variable.

Example with authentication and Top Bar integration:
```javascript
// pp-dev.config.js
module.exports = {
  backendBaseURL: 'https://mi.company.com',
  appId: 1,
  personalAccessToken: process.env.MI_ACCESS_TOKEN,
  miHudLess: true,
  integrateMiTopBar: true,
};
```

**Environment Variable**: Set `MI_ACCESS_TOKEN` in your `.env` file:
```bash
MI_ACCESS_TOKEN=your_token_here
```

### Enhanced Authentication (v0.11.0+)

The new authentication system in v0.11.0 provides:

- **Automatic Environment Loading**: Automatically loads `MI_*` environment variables from `.env` files
- **Token Validation**: Enhanced token validation and error handling
- **Secure Headers**: Automatic header management for authenticated requests
- **Connection Pooling**: Optimized HTTP connections for better performance

**Supported Environment Variables**:
- `MI_ACCESS_TOKEN`: Personal access token for authentication
- `MI_BACKEND_URL`: Alternative to `backendBaseURL` in config
- `MI_APP_ID`: Alternative to `appId` in config

**Automatic Loading**: pp-dev automatically detects and loads these variables from your project's `.env` file:
```bash
# .env
MI_ACCESS_TOKEN=your_personal_access_token
MI_BACKEND_URL=https://mi.company.com
MI_APP_ID=123
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

**Development Shortcuts**:
- `p` - Start/stop performance profiler (v0.11.0+)
- `l` - Proxy re-login (refresh authentication)
- `r` - Restart dev server
- `u` - Show server URLs
- `q` - Quit dev server

**Performance Profiling**: Use the `p` shortcut to start/stop the Node.js profiler for detailed performance analysis during development.

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
- **Node.js** version 20 or higher is required
- **TypeScript** version 4.2 or higher is supported

### Getting Help

- Check the [GitHub Issues](https://github.com/mi-examples/pp-dev-js/issues) for known problems
- Review the [CHANGELOG.md](./CHANGELOG.md) for recent changes
- Ensure all peer dependencies are properly installed
