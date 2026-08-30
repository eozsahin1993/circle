// Runs before expo-sqlite-mock's own setup (via jest's `setupFiles`, which
// runs earlier than `setupFilesAfterEnv`). Points the mock at a unique
// database file per test run so it can never collide with a lock left by a
// previous run's process — see the "table already exists" hang investigation.
process.env.EXPO_SQLITE_MOCK = `/tmp/expo-sqlite-mock-${process.env.JEST_WORKER_ID ?? '0'}-${Date.now()}-${process.pid}.db`;
