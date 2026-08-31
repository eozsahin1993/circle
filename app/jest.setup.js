// Runs before expo-sqlite-mock's own setup (via jest's `setupFiles`, which
// runs earlier than `setupFilesAfterEnv`). Points the mock at a unique
// database file per test run so it can never collide with a lock left by a
// previous run's process — see the "table already exists" hang investigation.
process.env.EXPO_SQLITE_MOCK = `/tmp/expo-sqlite-mock-${process.env.JEST_WORKER_ID ?? '0'}-${Date.now()}-${process.pid}.db`;

// expo-sqlite tries to connect a DevTools client to the Metro dev server
// every time a database is opened — there's no dev server under Jest, so
// this always fails and logs a `console.warn` with a full stack trace on
// every test run. It's an internal file within the expo-sqlite package
// (not a package import itself), so it can't use the `__mocks__/` auto-mock
// convention like expo-secure-store/expo-crypto, and expo-sqlite's
// package.json `exports` map doesn't expose this subpath for
// `require.resolve()` either — so, like expo-sqlite-mock's own setup.ts
// does for a different internal file, target it by filesystem path
// instead. This is the compiled `build/` output that actually runs at
// test time (Jest's stack traces show the `src/*.ts` sourcemap-remapped
// location instead, which is misleading here). Must be a template literal,
// not a variable built via path.join()/require.resolve() — Jest hoists
// jest.mock() calls above local variable declarations, so a computed path
// would still be `undefined` by the time this actually registers.
jest.mock(`${__dirname}/node_modules/expo-sqlite/build/SQLiteDevToolsClient`, () => ({
  registerDatabaseForDevToolsAsync: jest.fn(),
  unregisterDatabaseForDevToolsAsync: jest.fn(),
  closeDevToolsClientAsync: jest.fn(),
}));
