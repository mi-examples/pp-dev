# pp-dev

<p align="center">
   <a href="https://www.npmjs.com/package/@metricinsights/pp-dev"><img alt="npm" src="https://img.shields.io/npm/v/%40metricinsights%2Fpp-dev?logo=npm&label=npm%20package"></a>
   <a href="https://github.com/mi-examples/pp-dev-js/actions/workflows/publish.yml"><img alt="GitHub Workflow Status (with event)" src="https://img.shields.io/github/actions/workflow/status/mi-examples/pp-dev-js/publish.yml?logo=github"></a>
</p>

The PP Dev Helper is a development framework and build tool for Metric Insights' Portal Pages, designed to make the
lives of PP developers easier:

- build your Portal Page
- run/test locally with API requests proxied to a Metric Insights server
- a lot more (to be documented soon!)

pp-dev is based on [Vite](https://vitejs.dev/).

## Usage

Package installation

```shell
$ npm i @metricinsights/pp-dev
```

### Define Configuration

You'll need to create a file with the name `pp-dev.config` and extension `js` or
`cjs` (if you define type `module` in package.json), or `ts` if you want to use TypeScript, or `json`.

Alternatively, you can define configuration in your `package.json` via the `pp-dev` key

Generic configuration examples:

- JavaScript

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

- TypeScript

```typescript
// pp-dev.config.ts

import { PPDevConfig } from '@metricinsights/pp-dev';

const config: PPDevConfig = {
  backendBaseURL: 'https://mi.company.com',
  portalPageId: 1,
};

export default config;
```

- JSON as `pp-dev.config.json`

```json
{
  "backendBaseURL": "https://mi.company.com",
  "portalPageId": 1
}
```

- JSON as `package.json`

```json
{
  "name": "<project-name>",
  "version": "1.0.0",
  "scripts": {},
  "pp-dev": {
    "backendBaseURL": "https://mi.company.com",
    "portalPageId": 1
  }
}
```

## [Next.js](https://nextjs.org/) Configuration

To use the PP Dev Helper with Next.js:

1. Add pp-dev config to your root directory.

2. Change your `dev` script in `package.json` to `pp-dev next`.

3. Finally, wrap your next.config with a `withPPDev` function.

```javascript
// next.config.js

const { withPPDev } = require('@metricinsights/pp-dev');

module.exports = withPPDev({
  // your next config
});
```

### Vite configuration

If you need to change something in the build you can define a `vite.config` file.
More details [Vite Confighere](https://vitejs.dev/config/)

### Configuration API description

#### `backendBaseURL`

Type: String

Example: `https://mi.company.com`

Description: Defines the backend URL (Metric Insights instance) that is used for proxying requests to the MI backend

#### `portalPageId`

Type: Number

Example: `1`

Description: Defines the Portal Page ID that used to get Portal Page Variable values.

#### `miHudLess`

Type: Boolean

Default: `false`

Example: `true`

Description: Disables Metric Insights navigation bar for local development

#### `templateLess`

Type: Boolean

Default: `false`

Example: `true`

Description: Disables Template Variables transformation. Used when developing a Portal Page without a template

#### `enableProxyCache`

Type: Boolean

Default: `true`

Description: Enables proxy cache. If you want to disable proxy cache, you need to set this option to `false`

#### `proxyCacheTTL`

Type: Number

Default: `10 * 60 * 1000`

Description: Defines proxy cache TTL in milliseconds

#### `disableSSLValidation`

Type: Boolean

Default: `false`

Description: Disables SSL certificate validation for proxy requests. Useful for self-signed certificates

#### `imageOptimizer`

Type: Boolean | Object

Default: `true`

Description: Enables image optimization for build.
If you want to disable image optimization, you need to set this option to `false`.
If you want to customize image optimization, you need to set this option to an object with properties that are described
in the [vite-plugin-image-optimizer](https://www.npmjs.com/package/vite-plugin-image-optimizer#plugin-options)

#### `outDir`

Type: String

Default: `dist`

Description: Define the output directory for the build

#### `distZip`

Type: Boolean | { outDir?: string, outFileName?: string }

Default: `true`

Description: Enables zipping the build output.
If you want to disable zipping the build output, you need to set this option to `false`.
If you want to customize zipping the build output,
you need to set this option to an object with properties `outDir` and `outFileName`.

- `outDir` defines the output directory for the zipped build.
- `outFileName` defines the output file name for the zipped build.
  You can use placeholder `[templateName]` in the file name to replace it with the template name.

#### `syncBackupsDir`

Type: String

Default: `backups`

Description: Define the directory for the asset backups that are used for backup assets from the MI server

#### `v7Features`

Type: Boolean

Default: `false`

Description: Enables V7 features.
If you want to enable V7 features, you need to set this option to `true`.
This option is used for enabling new features that are available only on the Metric Insights v7 instances.
When setting this option to `true`, the CLI will use apply changes:
1. Default development path will be changed from `/pt/<portal-page-name>` to `/pl/<portal-page-name>`. This will avoid conflicts with the Metric Insights v7 features when developing a Portal Page with the Metric Insights toolbar.
2. The Code Sync feature will use the new URLs of the Metric Insights v7 instances **(not implemented yet)**

### CLI API description

`pp-dev help` - show CLI's help

Global options:

- `-c, --config <configFile>` - define the path to the configuration file. Default is `pp-dev.config.js`
- `--base <path>` - public base path (default: `/`)
- `-l, --logLevel <level>` - define the log level. Default is `info`. Available options: `trace`, `debug`, `info`, `warn`, `error`, `silent`
- `--clearScreen` - clear the screen before logging
- `--mode <mode>` - define the environment mode. Default is `development`. Available options: `development`, `production`, `test`

#### `pp-dev`

Aliases: `pp-dev dev`, `pp-dev serve`

Runs application in development mode with hot-reload. Also, its proxies requests to the MI server.

Available options and arguments:

- `[root]` - define the root directory for the application. Default is `.`
- `--host <host>` - define the host for the application. Default is `localhost`
- `--port <port>` - define the port for the application. Default is `3000`
- `--open [path]` - open the application in the default browser. You can define the path to open the browser with the specific page
- `--strictPort` - enable strict port checking. If the port is already in use, the application will exit with an error

#### `pp-dev next`

Aliases: `pp-dev next-server`, `pp-dev next-dev`

Runs the Next.js application in development mode with hot-reload. Also, its proxies requests to the MI server.

Available options and arguments:

- `[root]` - define the root directory for the application. Default is `.`
- `--port <port>` - define the port for the application. Default is `3000`
- `--host <host>` - define the host for the application. Default is `localhost`

#### `pp-dev build`

Runs the application build. Will create `dist` and `dist-zip` folders. `dist` folder contains unzipped build files. `dist-zip` contains file `<package-name>.zip` with files from the `dist` folder

Available options and arguments:

- `[root]` - define the root directory for the application. Default is `.`
- `--target <target>` - transpile target. Default is `modules`.
- `--outDir <outDir>` - define the output directory for the build. Default is `dist`
- `--assetsDir <dir>` - directory under outDir to place assets in Default is `assets`
- `--changelog [assetsFile]` - create a changelog file. You can define the path to the assets file or set `true` to use the default path. Default is `true`. Default path is `backups/<latest>.zip` where `<latest>` is the latest backup file

#### `pp-dev changelog [oldAssetPath] [newAssetPath]`

Create a changelog file. You can define the path to the previous and current assets files. If you don't define the path to the previous assets and current assets file, the CLI will try to get it from options. If you don't define the path to the current assets file, the CLI will throw an error.

Available options and arguments:

- `[oldAssetPath]` - define the path to the current assets file. Can accept path to the folder or path to the zip file
- `[newAssetPath]` - define the path to the previous assets file. Can accept path to the folder or path to the zip file
- `--oldAssetsPath <oldAssetsPath>` - define the path to the previous assets file. Can accept path to the folder or path to the zip file
- `--newAssetsPath <newAssetsPath>` - define the path to the current assets file. Can accept path to the folder or path to the zip file
- `--destination <destination>` - define the destination path for the changelog file. Default is `.`
- `--filename <filename>` - define the filename for the changelog file. Default is `CHANGELOG.html`

#### `pp-dev generate-icon-font [source] [destination]`

Generate an icon font from the source folder. You can define the path to the source folder and the destination folder. If you don't define the path to the source folder, the CLI will try to get it from options. If you don't define the path to the destination folder, the CLI will throw an error.

Available options and arguments:

- `[source]` - define the path to the source folder with SVG icons
- `[destination]` - define the path to the destination folder for the generated icon font and styles
- `--source <source>` - define the path to the source folder with SVG icons
- `--destination <destination>` - define the path to the destination folder for the generated icon font and styles
- `--fontName <fontName>` - define the font name. Default is `icon-font`

## Migration guide from old Portal Page Helper to new

1. Initialize npm in your portal page repository (if you have `package.json` file in PP folder, you can skip this step):

   Go to portal page folder and run command. This command will create `package.json` file in your folder

   ```shell
   $ npm init
   ```

2. Install this package by this command:
   ```shell
    $ npm i @metricinsights/pp-dev
   ```
3. Create two scripts in `package.json` script section.

   - `start` script: `"start": "pp-dev"`
   - `build` script: `"build": "pp-dev build"`

4. Change all paths to the file in index.html to the absolute path.
   If you have a path like `/pt/main.js` this must be changed to `/main.js`.
   Also, you may need to add `type="module"` to every script that is added by the `script` tag with the `src` property.
   Actually would be good to have only one `script` tag with the `src` tag.
   Every other JS file will be imported with construction like this `import helper from './helpers';`
