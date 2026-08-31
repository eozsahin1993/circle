// Package ports defines the interfaces domain logic depends on. Nothing
// storage- or runtime-specific is allowed to leak past this package.
package ports

import "context"

// LogEntry is one entry in a circle's append-only log — never decrypted
// content.
type LogEntry struct {
	Epoch         int64
	EncryptedMeta []byte
	ReceivedAt    int64
}

type FetchSinceResult struct {
	// Entries strictly after Since, oldest first.
	Entries []LogEntry
	// LatestEpoch may be higher than the highest entry returned — some
	// may have been ring-buffer trimmed.
	LatestEpoch int64
	// OldestAvailableEpoch: a caller behind this point can't catch up
	// incrementally anymore.
	OldestAvailableEpoch int64
}

// CommitResult is what a successful (or idempotently-retried) commit hands
// back — the epoch/receivedAt that ended up canonical for entryID.
type CommitResult struct {
	Epoch      int64
	ReceivedAt int64
}

// LogStore is storage for the append-only per-circle log. CommitEntry is
// the one write path that must be atomic — a plain, backend-agnostic
// signature (no DynamoDB types), but each adapter is expected to use its
// backend's real transaction primitive underneath (DynamoDB:
// TransactWriteItems; Postgres: a SQL transaction; etc.) rather than
// faking atomicity by composing smaller calls, which is what forced this
// package to reason about partial-failure orderings the first time around.
type LogStore interface {
	// CommitEntry atomically assigns the next epoch for circleLogID,
	// writes encryptedMeta against it, and records entryID as having
	// produced it. entryID is the client's own id for whatever it's
	// appending (a post today, not necessarily always) — calling this
	// again with an entryID already recorded for this circle returns the
	// *original* epoch/receivedAt rather than creating a second entry,
	// so a retry is always safe.
	CommitEntry(ctx context.Context, circleLogID, entryID string, encryptedMeta []byte) (CommitResult, error)

	Read(ctx context.Context, circleLogID string, since int64) (FetchSinceResult, error)

	// Trim enforces the ring buffer cap — best-effort, not required to be
	// atomic with CommitEntry.
	Trim(ctx context.Context, circleLogID string) error
}
