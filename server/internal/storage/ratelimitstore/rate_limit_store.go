// Package ratelimitstore defines the interface domain logic depends on for
// per-account request budgets — implementations live in subpackages, one
// per backing technology (see ratelimitstore/dynamodb). Nothing storage- or
// runtime-specific is allowed to leak past this package.
package ratelimitstore

import "context"

// Store tracks a fixed-window request budget per key. A single Store value
// is configured (at construction) with one particular limit and window —
// server/internal/api/router.go wires up two separate instances against
// the same underlying table, one for write-type circle endpoints and one
// (with a much higher limit) for reads, so a caller's key never has its
// write and read budgets confused with each other.
type Store interface {
	// Allow atomically consumes one unit of key's budget for the current
	// window and reports whether the request may proceed. key is
	// caller-defined — server/internal/api/ratelimit's middleware passes
	// the authenticated accountID.
	Allow(ctx context.Context, key string) (bool, error)
}
