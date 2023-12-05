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

### CLI API description

- `pp-dev help` - show CLI's help

- `pp-dev` or `pp-dev serve` or `pp-dev dev` runs application in development mode
- `pp-dev build` starts the application build. Will create `dist` and `dist-zip` folders. `dist` folder contains
  unzipped build files. `dist-zip` contains file `<package-name>.zip` with files from the `dist` folder

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
