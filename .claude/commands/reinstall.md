Rebuild the pp-dev package and reinstall it in all test fixtures.

## When to use

After changing source files in the root package that test fixtures depend on, or after bumping the root package version.

## Steps

1. From the repo root, run:
   ```bash
   npm run reinstall:all
   ```
   This runs `npm run build` first (via `prereinstall:all`) and then reinstalls the fresh `.tgz` in all test fixtures.
2. Run `npm run audit:all` to confirm 0 vulnerabilities across all packages.
3. Run `npm run test` to confirm nothing broke.
