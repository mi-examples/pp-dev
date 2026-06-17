Run the full repo-wide npm audit and fix all vulnerabilities.

## Steps

1. Run `npm run audit:all` from the repo root to see the current state across all packages (root + every `tests/*` fixture).
2. For each package with vulnerabilities:
   a. Run `npm audit fix` in that package directory.
   b. If issues remain ("No fix available"), add or update `overrides` in that package's `package.json` to force the patched version, then run `npm install` there.
3. Run `npm run audit:all` again to confirm all packages report 0 vulnerabilities.
4. If root `package-lock.json` changed, commit it: `chore(deps): fix npm audit vulnerabilities`.
5. If test-fixture `package.json` or `package-lock.json` changed:
   - Run `npm run build` in the root to rebuild the `.tgz`.
   - Run `npm run reinstall` in each affected fixture.
   - Run `npm run audit:all` one final time.
   - Commit: `chore(deps): fix audit vulnerabilities in test fixtures`.

## Key rule

Never use bare `npm audit`. Always `npm run audit:all` — it covers root AND all `tests/*` packages.
