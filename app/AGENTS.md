# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# Running tests

`npx jest` can hang indefinitely (not error — just never return, and the
stuck process resists even `kill -9`) if the active Node version's ABI
doesn't match the native SQLite binding (`better-sqlite3`, used by
`expo-sqlite-mock` in tests) that `node_modules` was installed under. This
has bitten multiple sessions in sandboxed/restricted shells specifically —
a plain Homebrew/system `node` on the PATH is a common mismatch. Before
running any test in this app, switch to the pinned version first:

```bash
eval "$(fnm env)" && fnm use   # reads ./.node-version (22.23.2) — matches CI
```

Then run tests with:

```bash
npx jest --ci --forceExit --runInBand
```

`--forceExit` is required in constrained shells to actually get control
back after tests finish. `--runInBand` hasn't been proven necessary but
has been reliable where the default worker-process model has not. Real
CI (`.github/workflows/app-unit-test.yml`) runs plain `npx jest --ci` on
Node 22.23.2 and passes quickly with no special flags — this workaround
is specific to constrained local/sandboxed shells, not a sign anything is
actually wrong with the test suite.

## After editing a migration `.sql`, run tests with `--no-cache`

Jest caches the transformed contents of `src/data/db/migrations/*.sql`
and does **not** reliably invalidate that cache when one changes. Tests
then run the *old* migration against the *new* `schema.ts`, and fail with
a thoroughly misleading error:

```
SqliteError: table pending_join_requests has no column named circle_id
```

— pointing at a column the migration visibly does declare. It's a stale
cache, not a broken migration. Re-run with `--no-cache` once after
touching any migration:

```bash
npx jest --ci --forceExit --runInBand --no-cache
```

Everyday runs (no migration changes) don't need it.
