# Contributing to pp-dev

## Commit Message Convention

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification for our commit messages. This helps us automatically generate changelogs and determine semantic version numbers.

### Commit Message Format

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation only changes
- `style`: Changes that do not affect the meaning of the code (white-space, formatting, missing semi-colons, etc)
- `refactor`: A code change that neither fixes a bug nor adds a feature
- `perf`: A code change that improves performance
- `test`: Adding missing tests or correcting existing tests
- `chore`: Changes to the build process or auxiliary tools and libraries such as documentation generation

### Scopes

The scope should be the name of the component or feature affected (as perceived by the person reading the changelog).

Examples:

- `feat(helper)`: New feature in the helper component
- `fix(api)`: Bug fix in the API
- `docs(readme)`: Documentation changes in README

### Examples

```
feat(helper): add new info panel component
fix(api): handle missing response data
docs(readme): update installation instructions
```

## Release Process

Releases use the shared workflows from [mi-examples-workflows](https://github.com/mi-examples/mi-examples-workflows) ([release flow](https://github.com/mi-examples/mi-examples-workflows/blob/main/docs/workflows.md#release-workflows)). The caller is [`.github/workflows/release.yml`](.github/workflows/release.yml).

- **Betas.** Every push to `develop` with releasable commits publishes `X.Y.Z-beta.N` to npm under the `beta` dist-tag, with a GitHub prerelease. Install one with `npm install @metricinsights/pp-dev@beta`.
- **Production releases.**
  1. Run **Actions → Release → Run workflow**. It opens a release pull request `release/vX.Y.Z → main` with the version bump and the new `CHANGELOG.md` entry.
  2. Review and edit the entry in the pull request, then merge it.
  3. Merging publishes to npm under `latest` and creates the tag and the GitHub release. It also opens the back-merge pull request into `develop`.
- **Versions** come from the commit messages (see above):
  - `feat` → minor;
  - `fix`, `perf` and `revert` → patch;
  - `!` or a `BREAKING CHANGE:` footer → major;
  - other types don't release.
- **Publishing** uses npm Trusted Publishing (OIDC) from `release.yml` in the `npm-publish` environment. No npm token is needed or stored.
  - Don't rename `release.yml`: the trusted publisher is registered for that filename.
  - Setup and troubleshooting are in [npm-publishing.md](https://github.com/mi-examples/mi-examples-workflows/blob/main/docs/npm-publishing.md).
- **CI and release callers** are generated from `.github/mi-examples-workflows.json`. To change a CI setting, edit that file and run `npx github:mi-examples/mi-examples-workflows`; don't edit the callers by hand.
