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

The release process is automated using GitHub Actions and semantic-release. When you push to the main branch:

1. GitHub Actions workflow is triggered
2. The workflow:
   - Checks out the code
   - Sets up Node.js
   - Installs dependencies
   - Builds the package
   - Runs semantic-release

semantic-release will then:
1. Analyze your commits
2. Determine the next version number
3. Generate a changelog
4. Create a git tag
5. Publish to npm
6. Create a GitHub release

You don't need to manually update the version number or changelog - it's all handled automatically based on your commit messages.

### Required Secrets

The following secrets need to be configured in your GitHub repository:

- `NPM_TOKEN`: An npm access token with publish permissions
- `GITHUB_TOKEN`: Automatically provided by GitHub Actions

### Skipping CI

If you need to make changes to the release commit (like updating the changelog), you can skip the CI by including `[skip ci]` in your commit message. 