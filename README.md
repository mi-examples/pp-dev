# pp-dev

Portal Page development framework and build tool.

This package is based on [Vite](https://vitejs.dev/) tool.

## Usage

Package installation

```shell
$ npm i @metricinsights/pp-dev
```

### Define configuration

You need to create the file with the name `pp-dev.config` and extension `js` or
`cjs` (if you define type `module` in package.json) or `ts` if you want to use Typescript, or `json`.
You also can define configuration in `package.json` with the `pp-dev` key

Config examples:

- JavaScript

```javascript
// pp-dev.config.js

/**
* @type {import('@metricinsights/pp-dev').PPDevConfig}
*/
module.exports = {
backendBaseURL: 'https://example.metricinsights.com',
portalPageId: 1,
};
```

- Typescript

```typescript
// pp-dev.config.ts

import { PPDevConfig } from '@metricinsights/pp-dev';

const config: PPDevConfig = {
backendBaseURL: 'https://example.metricinsights.com',
portalPageId: 1,
};

export default config;
```

- JSON (`pp-dev.config.json`)

```json
{
"backendBaseURL": "https://example.metricinsights.com",
"portalPageId": 1
}
```

- JSON in `package.json` file

```json
{
"name": "<project-name>",
"version": "1.0.0",
"scripts": {},
"pp-dev": {
  "backendBaseURL": "https://example.metricinsights.com",
  "portalPageId": 1
}
}
```

### Vite configuration

If you need to change something in the build you can define `vite.config` file.
More description you can find [here](https://vitejs.dev/config/)

### Configuration API description

#### `backendBaseURL`

Type: String

Example: `https://example.metricinsights.com`

Description: Defines the backend URL (Metric Insights instance) that is used for proxying requests to the MI backend

#### `portalPageId`

Type: Number

Example: `1`

Description: Defines the Portal Page Id that used to get portal page variables values.

#### `miHudLess`

Type: Boolean

Default: `false`

Example: `true`

Description: Disables Metric Insights navigation bar for local development

#### `templateLess`

Type: Boolean

Default: `false`

Example: `true`

Description: Disables template variables transforming. Used when you develop the portal page without a template

### CLI API description

- `pp-dev help` - show CLI's help

- `pp-dev` or `pp-dev serve` or `pp-dev dev` runs application in development mode
- `pp-dev build` starts the application build. Will create `dist` and `dist-zip` folders. `dist` folder contains unzipped build files. `dist-zip` contains file `<package-name>.zip` with files from the `dist` folder

## Migration guide from old portal page helper to new

1. You need to initialize npm in your portal page repository (if you have `package.json` file in PP folder, you can skip this step):

   Go to portal page folder and run command. This command will create `package.json` file in your folder

   ```shell
   $ npm init
   ```

2. You need to install this package by this command:
   ```shell
    $ npm i @metricinsights/pp-dev
   ```
3. You need to create two scripts in `package.json` script section.

   - `start` script: `"start": "pp-dev"`
   - `build` script: `"build": "pp-dev build"`

4. You need to change all paths to the file in index.html to the absolute path.
   If you have a path like `/pt/main.js` this must be changed to `/main.js`.
   Also, you may need to add `type="module"` to every script that is added by the `script` tag with the `src` property.
   Actually would be good to have only one `script` tag with the `src` tag.
   Every other JS file will be imported with construction like this `import helper from './helpers';`
