# Changelog

## [1.4.2](https://github.com/mi-examples/pp-dev/compare/v1.4.1...v1.4.2) (2026-09-23)

### Bug Fixes

* **next-build:** remove stale dev route types before `next build` ([6d74218](https://github.com/mi-examples/pp-dev/commit/6d7421844896ccfdaa834faca5cfbe6f85d8df57))
* **security:** replace extract-zip with validated jszip extraction ([40f19d1](https://github.com/mi-examples/pp-dev/commit/40f19d131da3f3a290415993e74fe49ca91a9907))

## [1.4.1](https://github.com/mi-examples/pp-dev/compare/v1.4.0...v1.4.1) (2026-09-04)

### Bug Fixes

* **dist:** normalize SVGs to match MI's server-side re-serialization ([fb8441d](https://github.com/mi-examples/pp-dev/commit/fb8441dbe8ea6394cf2ed383bff02fa5dea850d0))
* **variables-editor:** allow numeric values for non-static select/multi-select list columns ([cff62ca](https://github.com/mi-examples/pp-dev/commit/cff62ca24d4e713dd1afa6d625d107e1e709c1f7))
* **variables-editor:** render {id,text} options correctly in list-column select validation warnings ([263777f](https://github.com/mi-examples/pp-dev/commit/263777f6008d1003141e5198d9af64fa39ab0faf))
* **migrate:** read pp-dev config from package.json ([78c89a5](https://github.com/mi-examples/pp-dev/commit/78c89a5515d6f475b099d8c992f106c814085044))

## [1.4.0](https://github.com/mi-examples/pp-dev/compare/v1.3.0...v1.4.0) (2026-08-28)

### Features

* **variables-editor:** import variable values from another page ([5c5bf2e](https://github.com/mi-examples/pp-dev/commit/5c5bf2eaf63499d3abb4cdc07645f378b9bdb533))

### Bug Fixes

* **variables-editor:** render {id,text} options correctly in list-column select widgets ([dfb031c](https://github.com/mi-examples/pp-dev/commit/dfb031c69c53f11ec5e445f3405ab6b451154d75))
* **variables-editor:** allow manual input for non-static list columns, treat null list value as empty array ([368e218](https://github.com/mi-examples/pp-dev/commit/368e218f4a928ab5daf756e8319c4b0dff5fa31d))

## [1.3.0](https://github.com/mi-examples/pp-dev/compare/v1.2.2...v1.3.0) (2026-08-19)

### Features

* **ui:** improve variables editor schema/values UX ([6610ee5](https://github.com/mi-examples/pp-dev/commit/6610ee54056ab6c6339fc5b2549f811483ac1712))

### Bug Fixes

* **variables-editor:** guard missing browser APIs, update stale test selectors ([21fa412](https://github.com/mi-examples/pp-dev/commit/21fa412ded827a9266aa4d8e8d5d524e8c36c748))
* **security:** reject unvalidated symlinks after zip extraction ([707d8cc](https://github.com/mi-examples/pp-dev/commit/707d8cc08d9ae1bb0955a111307253ed98d6b70c))
* **proxy:** rewrite JSON and XML streams, and respect client backpressure ([e653e93](https://github.com/mi-examples/pp-dev/commit/e653e93a5bdba03a0289a495aef361f5df3898bb))
* **proxy:** rewrite URLs and forward status for streamed responses ([94dc9dd](https://github.com/mi-examples/pp-dev/commit/94dc9dd8e91c84d5b6513071770797a0c8ac1c5e))

### Changes

* [Internal] PP Dev helper variables editor UI ([005e72c](https://github.com/mi-examples/pp-dev/commit/005e72c1601106e724c840f8c09fb32d6d44f73d))

## [1.2.2](https://github.com/mi-examples/pp-dev/compare/v1.2.1...v1.2.2) (2026-08-10)

### Bug Fixes

* **build:** resolve an explicit relative backupFolder against root ([65c7c08](https://github.com/mi-examples/pp-dev/commit/65c7c08b79ba2379d89deaf5119406e9c0dd71d3))
* **ui:** widen the popup close button's hit area to 24px ([36dcffa](https://github.com/mi-examples/pp-dev/commit/36dcffa6de0cf34953b8b2e5430ab0d83972184f))
* **ui:** handle failed variable editor fetches instead of hanging ([c1bfc21](https://github.com/mi-examples/pp-dev/commit/c1bfc21bef7201690774fd514c024d90a1670711))
* **build:** resolve packaging paths against the Vite project root ([795a378](https://github.com/mi-examples/pp-dev/commit/795a3784a6cbe8ee6274cd0db098ec2adc379e6b))
* **env:** stop MI_* values leaking across sequential project roots ([da55077](https://github.com/mi-examples/pp-dev/commit/da55077a24da9b7e5a8e500201624026e5f8d714))
* **ui:** make the popup close control an accessible button ([464613d](https://github.com/mi-examples/pp-dev/commit/464613d7d76d6c826dfe837572da5f78620a49ed))
* **deps:** remove invalid bundled npm patching ([17eb209](https://github.com/mi-examples/pp-dev/commit/17eb209526a7d980c7303a195b27f3db335332b9))
* **build:** secure outputs and preserve sync ([d1244f0](https://github.com/mi-examples/pp-dev/commit/d1244f044eedc1c4e58517b2a5c97c92dff29a89))
* **api:** preserve variable editor data integrity ([082ec2a](https://github.com/mi-examples/pp-dev/commit/082ec2a37e3b54908c739c3abbfa7446850de278))
* **ui:** prevent unsafe HTML rendering ([332e31b](https://github.com/mi-examples/pp-dev/commit/332e31b8affbd0ea93ae6557c487a019ad16e140))
* Variables Editor name-validation hint false-positives on whitespace ([b7e721e](https://github.com/mi-examples/pp-dev/commit/b7e721e8048cd28001604021ed5aa4358757102e))

## [1.2.1](https://github.com/mi-examples/pp-dev/compare/v1.2.0...v1.2.1) (2026-08-07)

### Bug Fixes

* Variables Editor client script fails to parse, blanking the whole UI ([2e48b2e](https://github.com/mi-examples/pp-dev/commit/2e48b2e69c12124a6d300503a80b40f649de1316))

## [1.2.0](https://github.com/mi-examples/pp-dev/compare/v1.1.1...v1.2.0) (2026-08-07)

### Features

* add Auto/Dark/Light theme switcher, shared across the dev panel, Inspector, and Variables Editor ([b6f72a6](https://github.com/mi-examples/pp-dev/commit/b6f72a68181105dd620db967307bd3e3575911fe))
* add standalone Variables Editor page with dev-panel entry points ([40bc88e](https://github.com/mi-examples/pp-dev/commit/40bc88e45fd9b25d4a6d47249ef791272ff92c20))
* add page-variables API and schema/export/validation helpers ([36c727e](https://github.com/mi-examples/pp-dev/commit/36c727e7feeb45805ccae76984aaa755be2e8d7b))

### Bug Fixes

* address npm audit vulnerabilities in root and test fixtures ([a33aad3](https://github.com/mi-examples/pp-dev/commit/a33aad3ca7a24078d6a8293ebe45e065baf62d0b))
* Variables Editor — ergonomic advanced-fields toggle, confirm before delete ([6cc96ee](https://github.com/mi-examples/pp-dev/commit/6cc96eef13dfeb12684e136e43ade115981a33d4))
* Variables Editor tab switch no longer blanks out until the fetch resolves ([399930d](https://github.com/mi-examples/pp-dev/commit/399930d4da7e1e846f52648cfeae9509b9c36402))

## [1.1.1](https://github.com/mi-examples/pp-dev/compare/v1.1.0...v1.1.1) (2026-07-27)

### Bug Fixes

* address npm audit vulnerabilities in root and test fixtures ([342706d](https://github.com/mi-examples/pp-dev/commit/342706d27725211b0cc21f7c703e69222771f8cf))

## [1.1.0](https://github.com/mi-examples/pp-dev/compare/v1.0.0...v1.1.0) (2026-07-21)

### Features

* warn when a wrapped Next.js app builds via plain `next build` ([be6d4c2](https://github.com/mi-examples/pp-dev/commit/be6d4c2b4f6a176c2c3057e240106bc02b3781f7))
* add `next-build` command for Next.js build output parity with `pp-dev build` ([f16871e](https://github.com/mi-examples/pp-dev/commit/f16871ebbc05588800805cb2bd1ccfd27d25f763))
* extract shared next-build helpers and CLI/env build-output overrides ([cd455ac](https://github.com/mi-examples/pp-dev/commit/cd455ac4b8488178f72416d43267b4545aa508c9))

### Bug Fixes

* don't log VERSION/BUILD-MANIFEST written when versionFile is disabled ([100820c](https://github.com/mi-examples/pp-dev/commit/100820cddc0d283c00850e640e5dae7b065c0db4))
* address new npm audit advisories in root and test fixtures ([c02c3dc](https://github.com/mi-examples/pp-dev/commit/c02c3dc94a06d238df3c4383fb906b335db54eed))

## [1.0.0](https://github.com/mi-examples/pp-dev/compare/v0.19.0...v1.0.0) (2026-07-13)

### ⚠ BREAKING CHANGES

* pp-dev moves to the 1.0 release line. Node.js >= 24 is required (declared in engines) and the package is no longer published under the 0.x version scheme.

### Features

* add Dev Panel guide to README (position, auto-hide, hide/restore) ([54b8331](https://github.com/mi-examples/pp-dev/commit/54b833163bf65372f6ba55f5910cd7e3332261a9))
* update dependencies and start the 1.0 release line ([abdad45](https://github.com/mi-examples/pp-dev/commit/abdad45b87e752d7468994f821841adc9e288e70))
* configurable dev panel position, hide and auto-hide modes ([315d6fc](https://github.com/mi-examples/pp-dev/commit/315d6fc4182c1128f77fe192a425e3f816970f6f))
* **inspector:** print inspector URL banner to browser DevTools console ([9222397](https://github.com/mi-examples/pp-dev/commit/92223972ec5f649085a76afd22b2328aeafb0e97))
* **inspector:** add Request Inspector with web UI and REST API ([e53fa90](https://github.com/mi-examples/pp-dev/commit/e53fa90639bdb6ed917772169ea2cb4f36de28a8))
* **ui:** MI brand redesign — colors, Inter font, SVG type icons ([a0a30a5](https://github.com/mi-examples/pp-dev/commit/a0a30a5aafe07255cc74bb614d36f86a4ee64925))
* v1.0 grouped PPDevConfig schema, defineConfig helper, pp-dev migrate codemod ([222b4e5](https://github.com/mi-examples/pp-dev/commit/222b4e5949144295f07dd9fed87e131692323560))

### Bug Fixes

* stop request inspector from swallowing proxied PUT/POST bodies ([610a993](https://github.com/mi-examples/pp-dev/commit/610a9933ac0a7ec19ee349ff7c6490b605a739ed))
* guard release.yml against non-tag workflow_dispatch runs ([a7f463f](https://github.com/mi-examples/pp-dev/commit/a7f463f7c0e75f3305b2dfab560ee9a6c315343d))
* **ui:** align dev panel with design ([0d020e3](https://github.com/mi-examples/pp-dev/commit/0d020e32c3e1608cafdcc0c7a5b368524867a785))
* **build:** run rollup-plugin-dts in child process to prevent Windows hang ([d9466b0](https://github.com/mi-examples/pp-dev/commit/d9466b0884f3e0eb5d01ef864e18ba32c6ff7899))
* **ui:** align panel bar with Figma spec ([9ed1320](https://github.com/mi-examples/pp-dev/commit/9ed13200bb154753534a29b7f606b3fc663d3076))
* **security:** pin undici to ^7.28.0 to fix CVEs without breaking jsdom ([d03bd5e](https://github.com/mi-examples/pp-dev/commit/d03bd5e744e18695a7c05c3e3e6b545e2a00b219))
* **security:** patch npm/node-gyp undici <=6.26.0 high-severity CVEs ([d4c8a10](https://github.com/mi-examples/pp-dev/commit/d4c8a10e704c75b6d1c1b7bcd8166d007b5270a2))

## [0.19.0](https://github.com/mi-examples/pp-dev/compare/v0.18.3...v0.19.0) (2026-06-18)

### Features

* **next:** build template sync assets with `next build` ([f19c42e](https://github.com/mi-examples/pp-dev/commit/f19c42ec2b775706621470ba60185d1324d0b1ec))
* **next:** add dev panel for the Next.js dev server ([95dfd8e](https://github.com/mi-examples/pp-dev/commit/95dfd8e8be9e6fc1c63243a62c103eb597893ba9))

### Bug Fixes

* **next:** resolve sync export dir from the production config ([8b8275a](https://github.com/mi-examples/pp-dev/commit/8b8275aea0b501d8f3b1aabc6107865eefcac58e))
* **client:** keep the sync spinner running while confirmation modals are open ([da86bcb](https://github.com/mi-examples/pp-dev/commit/da86bcbe4c4fcfae6df4f99d081da43e8a6a958f))
* **middleware:** load template variables on deep-linked sub-path navigation ([a21c032](https://github.com/mi-examples/pp-dev/commit/a21c0323999300f326bdf5845f668a180cb7d121))
* **client:** send dev-panel WebSocket responses to the requesting client only ([d73700f](https://github.com/mi-examples/pp-dev/commit/d73700f7ab439422651e0fb38e48cbb4e37556e2))

## [0.18.3](https://github.com/mi-examples/pp-dev/compare/v0.18.2...v0.18.3) (2026-06-08)

### Bug Fixes

* **deps:** resolve npm audit findings across workspace ([bb41f5c](https://github.com/mi-examples/pp-dev/commit/bb41f5cec178d9db130cb5a51bbdabd0a42512dc))

## [0.18.2](https://github.com/mi-examples/pp-dev/compare/v0.18.1...v0.18.2) (2026-05-07)

### Bug Fixes

* **deps:** resolve npm audit findings across workspace ([d13ffad](https://github.com/mi-examples/pp-dev/commit/d13ffadcda69cf6f8c8de39c7b0f7d0840e6fa3a))

## [0.18.1](https://github.com/mi-examples/pp-dev/compare/v0.18.0...v0.18.1) (2026-04-22)

### Bug Fixes

* harden sync prompt lifecycle and metadata safety ([3aaaeb6](https://github.com/mi-examples/pp-dev/commit/3aaaeb6a2a706f7f2ba6639c5ce87a320626eb32))
* **cli:** harden shortcut cleanup and add dts trace logging ([4de05ed](https://github.com/mi-examples/pp-dev/commit/4de05ed2469933007aa654e370a84d90aecf3df3))

## [0.18.0](https://github.com/mi-examples/pp-dev/compare/v0.17.0...v0.18.0) (2026-04-07)

### Features

* rewrite /data/page/ path for v7 proxy when template differs from internal name ([a060da2](https://github.com/mi-examples/pp-dev/commit/a060da26e4d4cb9e80625f2015e5ab19b82a398d))

### Changes

* Add repo-wide npm audit script and align Vite to 8.0.5 ([3373e51](https://github.com/mi-examples/pp-dev/commit/3373e51aca9aea74b115359addd0956307d5f270))

## [0.17.0](https://github.com/mi-examples/pp-dev/compare/v0.16.1...v0.17.0) (2026-04-06)

### Features

* **cli:** Webpack fallback for Next dev when Turbopack native SWC fails ([5940f31](https://github.com/mi-examples/pp-dev/commit/5940f316cf86056196ad3f69a8b3667460866aeb))

## [0.16.1](https://github.com/mi-examples/pp-dev/compare/v0.16.0...v0.16.1) (2026-03-23)

### Bug Fixes

* move esbuild to dependencies for dev/runtime resolution ([aa7b57d](https://github.com/mi-examples/pp-dev/commit/aa7b57dd11b9bc49bb60b47c6b61759b56534e2b))

## [0.16.0](https://github.com/mi-examples/pp-dev/compare/v0.15.1...v0.16.0) (2026-03-23)

### Features

* version manifest plugin and upgrade to Vite 8 ([ad8c4ac](https://github.com/mi-examples/pp-dev/commit/ad8c4ac5b6bc7813d04947b418a5d3b77d2d75fb))

### Bug Fixes

* **version-plugin:** hash concatenated digests without hex input encoding ([1ea5e5a](https://github.com/mi-examples/pp-dev/commit/1ea5e5aed6b78b3bd67110d173a5195b75434e9c))

## [0.15.1](https://github.com/mi-examples/pp-dev/compare/v0.15.0...v0.15.1) (2026-03-12)

### Bug Fixes

* resolve all package vulnerabilities ([79d7e24](https://github.com/mi-examples/pp-dev/commit/79d7e245b94d0be8c133803842329309f0e1b432))

## [0.15.0](https://github.com/mi-examples/pp-dev/compare/v0.14.1...v0.15.0) (2026-03-02)

### Features

* add appId option and fix internal server restart ([ee74beb](https://github.com/mi-examples/pp-dev/commit/ee74beb07d0ffe091302c7af4b56b090ea5cb383))

### Bug Fixes

* add overrides to fix serialize-javascript and minimatch vulnerabilities ([3f79b97](https://github.com/mi-examples/pp-dev/commit/3f79b970b604f8e5656d15f743f51c6902b2e0d5))
* pass appId to initLoadPPData, remove debug logs, update lock file ([079c13b](https://github.com/mi-examples/pp-dev/commit/079c13bc3db2ea018d377ed01240ff7ffaea253d))
* add chokidar override to resolve npm ci sync ([3e24d40](https://github.com/mi-examples/pp-dev/commit/3e24d4020a33a5693f8aa442a0add6e80208719b))
* proxy middleware - add cache headers for login page, inject token for HTML ([452755f](https://github.com/mi-examples/pp-dev/commit/452755f73391a0a6e2e19223db8f703219f6d993))

## [0.14.1](https://github.com/mi-examples/pp-dev/compare/v0.14.0...v0.14.1) (2026-02-25)

### Bug Fixes

* **nextjs:** rewrite response middleware for Next.js page URLs ([3e80f41](https://github.com/mi-examples/pp-dev/commit/3e80f413c3106d9be918604ae0a5e28eeafc98d5))

## [0.14.0](https://github.com/mi-examples/pp-dev/compare/v0.13.2...v0.14.0) (2026-02-23)

### Features

* **cli:** appId support, base path handling ([63ec031](https://github.com/mi-examples/pp-dev/commit/63ec0318a18a14b06803a59e8ac2d4be225d4631))
* **cli:** appId support, base path handling, API routes passthrough ([2c16dae](https://github.com/mi-examples/pp-dev/commit/2c16daea94e11d72a0ce93be0f40ed9f29eb4d6a))

### Bug Fixes

* improve dev server restart reliability and config change detection ([3edd020](https://github.com/mi-examples/pp-dev/commit/3edd0206ab5d9e27e8088a8a55fc925f5a586f7f))
* ejs v4 default import for ESM compatibility ([e64f4c8](https://github.com/mi-examples/pp-dev/commit/e64f4c8fe1344a00daf575521215b0f82ec539ee))

## [0.13.2](https://github.com/mi-examples/pp-dev/compare/v0.13.1...v0.13.2) (2026-02-12)

### Bug Fixes

* **client-injection:** resolve DIRNAME to parent directory for correct resource paths ([606fd91](https://github.com/mi-examples/pp-dev/commit/606fd919ffda4988f4e1a0c11ce805cacfd75f1e))

## [0.13.1](https://github.com/mi-examples/pp-dev/compare/v0.13.0...v0.13.1) (2026-02-11)

### Features

* **cli:** watch.env and pp-dev config files, await Next.js check ([69a07f0](https://github.com/mi-examples/pp-dev/commit/69a07f0cbf0d3613fd1e6cdbf892cf0905005b51))
* **cli:** support Next.js 16 and fix base path regex escaping ([9182d2a](https://github.com/mi-examples/pp-dev/commit/9182d2a1d319239abf1b7b61cd40f03bbdf312fd))

### Bug Fixes

* **plugin:** correct DIRNAME path resolution in client injection ([dce83d7](https://github.com/mi-examples/pp-dev/commit/dce83d78e987e0555060552a51bf6d1d32154853))

### Changes

* Update plugin, CLI, client injection, and test configurations ([818f98d](https://github.com/mi-examples/pp-dev/commit/818f98d56e9f1a7c8d01ae56f3e9630f9fa473f1))

## [0.13.0](https://github.com/mi-examples/pp-dev/compare/v0.12.4...v0.13.0) (2026-01-27)

### Features

* **plugin:** enhance integrateMiTopBar with selective configuration options ([cbb9a6c](https://github.com/mi-examples/pp-dev/commit/cbb9a6c59db401201fb2530f46ca47eaaa585526))

### Bug Fixes

* **plugin:** add null check for integrateMiTopBar validation ([df35e2a](https://github.com/mi-examples/pp-dev/commit/df35e2a8a265bd4a6445ec78c9ae94d4c24f105d))

## [0.12.4](https://github.com/mi-examples/pp-dev/compare/v0.12.3...v0.12.4) (2026-01-14)

### Bug Fixes

* **plugin:** move topbar scripts injection to head-prepend ([a248f91](https://github.com/mi-examples/pp-dev/commit/a248f91b14817a36a37d56e9107762b514bf90ac))

### Reverts

* Revert " " ([0a795f7](https://github.com/mi-examples/pp-dev/commit/0a795f71bd2782d3f8deaf4da983d25851fb1516))
*  ([11d6553](https://github.com/mi-examples/pp-dev/commit/11d6553dec6360c0d4f9d141daab2c46360e8fbe))

## [0.12.3](https://github.com/mi-examples/pp-dev/compare/v0.12.2...v0.12.3) (2025-12-19)

### Bug Fixes

* **pp-dev:** improve node compatibility for SSL and buffer handling ([6a87065](https://github.com/mi-examples/pp-dev/commit/6a87065eb0bf07a34825a2fcb160aaaacd8d753a))

## [0.12.2](https://github.com/mi-examples/pp-dev/compare/v0.12.1...v0.12.2) (2025-09-10)

No notable changes.

## [0.12.1](https://github.com/mi-examples/pp-dev/compare/v0.10.1...v0.12.1) (2025-09-10)

### Features

* **pp-dev:** enhance CLI and core functionality ([fd7bc73](https://github.com/mi-examples/pp-dev/commit/fd7bc73222a9cf93dea6e106b903a90e89221386))
* **auth:** add global authentication provider ([c790e74](https://github.com/mi-examples/pp-dev/commit/c790e745e7e34aa3aa5d422cd8b75ada850af8c5))
* **pp-dev:** add postbuild script and package renaming utility ([ed60876](https://github.com/mi-examples/pp-dev/commit/ed60876960b81e6172fe27d92de8b79337f18b70))
* **pp-dev:** refactor CLI and core functionality ([e551859](https://github.com/mi-examples/pp-dev/commit/e551859cb16110ba380c1d2226c4ee33aa2521e4))
* **pp-dev:** add startup optimization and enhance authentication helpers ([b5e8607](https://github.com/mi-examples/pp-dev/commit/b5e860776742d0d4c50963c099afd747b7a61b62))
* **pp-dev:** add dependency version synchronization for create-pp-dev releases ([a2390ea](https://github.com/mi-examples/pp-dev/commit/a2390eab9412a719256155987c00d059a0c2ad18))
* **pp-dev:** add semantic release configuration and update dependencies ([1301fc6](https://github.com/mi-examples/pp-dev/commit/1301fc6a5fcc96de0e8cfc908857779768ed7346))
* **pp-dev:** add esbuild configuration and build optimization scripts ([f0b05ab](https://github.com/mi-examples/pp-dev/commit/f0b05abb8343ee3ebd6a3eec6648cc4623cbd5f7))

### Bug Fixes

* remove issue number references from semantic-release configs ([809cc83](https://github.com/mi-examples/pp-dev/commit/809cc8398c165e1054c849b10be26808de0bd609))

## [0.10.1](https://github.com/mi-examples/pp-dev/compare/v0.10.0...v0.10.1) (2025-04-25)

### Bug Fixes

* update build configuration and fix type issues ([5f7d7bf](https://github.com/mi-examples/pp-dev/commit/5f7d7bfcc6c5544b4476d0acbb5c746fed2968e0))

### Changes

* Update dependencies and improve package configurations ([4ae669e](https://github.com/mi-examples/pp-dev/commit/4ae669eb74df598c206603817f30359b8928a1f1))

## [0.10.0](https://github.com/mi-examples/pp-dev/compare/v0.9.0...v0.10.0) (2025-04-22)

No notable changes.

## [0.9.0](https://github.com/mi-examples/pp-dev/compare/v0.8.0...v0.9.0) (2025-02-03)

### Changes

* Added ability to sync template/page assets with the v7 instances (will work start from MI v7.1.0) ([18dd5c2](https://github.com/mi-examples/pp-dev/commit/18dd5c239fb3b536cc05ed30a9a64c73c5744a15))

## [0.8.0](https://github.com/mi-examples/pp-dev/compare/v0.7.0...v0.8.0) (2024-12-10)

### Changes

* Fixed `Not Found` error for portal pages with Mi HUD on the v7 instances ([a6e98f6](https://github.com/mi-examples/pp-dev/commit/a6e98f66fddc5a1fbab6396816f461f7e2d6884a))

## [0.7.0](https://github.com/mi-examples/pp-dev/compare/v0.6.0...v0.7.0) (2024-11-15)

### Changes

* Fixed issue with Path Routing, updated packages ([c0ed652](https://github.com/mi-examples/pp-dev/commit/c0ed652c668f9b6e0e4457d2f69b1a99c7912ef9))

## [0.6.0](https://github.com/mi-examples/pp-dev/compare/v0.5.0...v0.6.0) (2024-03-06)

### Changes

* Fixed issue with template loading ([339b90f](https://github.com/mi-examples/pp-dev/commit/339b90f83929eee6d81cfb773190277ccaba07fd))
* Added CLI command to build icon font ([9174f3d](https://github.com/mi-examples/pp-dev/commit/9174f3d0e3cbea3a3473d4e912ed44b77ff4edec))

## [0.5.0](https://github.com/mi-examples/pp-dev/compare/v0.4.0...v0.5.0) (2024-02-27)

### Changes

* Fixed bug with changelog generator when selected two zip archive for changelog ([5608bc8](https://github.com/mi-examples/pp-dev/commit/5608bc8411f667e25e836e03619a82002f66ab5c))
* Added image optimization tool ([1d7347b](https://github.com/mi-examples/pp-dev/commit/1d7347bc5859d92bf0aab53fc54e82f05820fa0e))
* Added changelog generator for assets ([74a492b](https://github.com/mi-examples/pp-dev/commit/74a492bd50d731d6b679f2fbcd0ff3ee022331a9))
* Improved helper logging ([0d5dd87](https://github.com/mi-examples/pp-dev/commit/0d5dd87b1c199abab13cfc591ca3459692a95e83))

## [0.4.0](https://github.com/mi-examples/pp-dev/compare/v0.3.3...v0.4.0) (2023-12-05)

### Changes

* Added new feature for disabled SSL validation ([fae1c73](https://github.com/mi-examples/pp-dev/commit/fae1c73c18e31e2afec63bf61c47a64045a3df7f))

## [0.3.3](https://github.com/mi-examples/pp-dev/compare/v0.3.2...v0.3.3) (2023-12-04)

### Changes

* Fixed Next.js dependency versions ([7c9d2e1](https://github.com/mi-examples/pp-dev/commit/7c9d2e1ec99c64ed0e6f30ce429f020da4322fad))

## [0.3.2](https://github.com/mi-examples/pp-dev/compare/v0.3.1...v0.3.2) (2023-11-14)

### Changes

* Fixed problem with import for non Next.js projects ([f7ef7a3](https://github.com/mi-examples/pp-dev/commit/f7ef7a3ecc74de0b93b9b6ed35e499cd762c5a8a))

## [0.3.1](https://github.com/mi-examples/pp-dev/compare/v0.3.0...v0.3.1) (2023-11-09)

### Changes

* Next.js support ([661797e](https://github.com/mi-examples/pp-dev/commit/661797e142bf43fd0aa110b0232c3debabd85b59))

## [0.3.0](https://github.com/mi-examples/pp-dev/compare/v0.2.0...v0.3.0) (2023-10-18)

### Changes

* Added Next.js support (beta) ([a713818](https://github.com/mi-examples/pp-dev/commit/a71381889dcbb1023c4432159b3c10bc2b8bbc09))

## [0.2.0](https://github.com/mi-examples/pp-dev/compare/v0.1.1...v0.2.0) (2023-08-31)

### Changes

* Implemented the ability to synchronize current code with the backend ([bb302dc](https://github.com/mi-examples/pp-dev/commit/bb302dc28c5285718b4f446a12cb71375bd09d24))

## [0.1.1](https://github.com/mi-examples/pp-dev/compare/v0.1.0...v0.1.1) (2023-08-09)

### Changes

* Fixed URL params working in helper ([469347e](https://github.com/mi-examples/pp-dev/commit/469347e3858da1a912bd79f0140d7af153c2658f))

## [0.1.0](https://github.com/mi-examples/pp-dev/compare/v0.0.3...v0.1.0) (2023-07-12)

### Changes

* Added no-cache headers to PP variables requests and some UI changes ([469cf31](https://github.com/mi-examples/pp-dev/commit/469cf314853713bbe3a790dd6cf7703ba2f96b8e))
* Fixed incorrect links in helper info panel ([9f3f2b3](https://github.com/mi-examples/pp-dev/commit/9f3f2b364423dd22cdff607d1fba04e9eac0c175))
* Fixed issue with many requests to the backend ([0b49850](https://github.com/mi-examples/pp-dev/commit/0b4985032cebeae9e1722efa2454a4416ac25183))

## [0.0.3](https://github.com/mi-examples/pp-dev/compare/v0.0.2...v0.0.3) (2023-06-19)

### Changes

* [PP Helper] Polishing styles for helper info panel ([1dfb329](https://github.com/mi-examples/pp-dev/commit/1dfb329bffb01bce4ce2462ad4dc66c56074038a))

## 0.0.2 (2023-06-08)

### Changes

* Added documentation ([8d77a07](https://github.com/mi-examples/pp-dev/commit/8d77a07838baf1737a936e37ad1b459258502244))
* Added package for CI/CD ([7648e85](https://github.com/mi-examples/pp-dev/commit/7648e855db00ebc694597b6a1458c83d5482ac16))
* Implemented pp-dev package ([fe989e1](https://github.com/mi-examples/pp-dev/commit/fe989e1b39497c8485999b856fcf21aed10a45e5))
