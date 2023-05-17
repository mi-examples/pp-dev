# pp-dev

Portal Page development framework

## Usage

Package installation

```shell
$ npm i @metricinsights/pp-dev
```

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
