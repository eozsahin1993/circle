// Package authstore defines the interface domain logic depends on for
// device/session state — implementations live in subpackages, one per
// backing technology (see authstore/dynamodb). Nothing storage- or
// runtime-specific is allowed to leak past this package.
package authstore

import (
	"context"
	"time"
)

// Session is what a bearer token resolves to. Deliberately not emailHmac
// itself: emailHmac is permanent (same email address, same value, forever),
// so using it directly as the request credential would mean no way to
// revoke or rotate access without banning the email address outright. A
// session token is random and independently revocable/expirable —
// "who you are" and "what currently authorizes you" are different things.
type Session struct {
	DeviceID  string
	ExpiresAt time.Time
}

// Store persists active sessions, keyed by bearer token — the raw email
// address itself is never passed to any Store method; that's the caller's
// job to hash first.
type Store interface {
	// SaveSession records a freshly-issued bearer token. Overwrites
	// nothing meaningful in practice — token is caller-generated random,
	// collisions aren't a real concern.
	SaveSession(ctx context.Context, token string, session Session) error
	// GetSession returns nil, nil if the token doesn't exist or has
	// expired — callers should still check ExpiresAt themselves, same
	// eventually-consistent-TTL caveat DynamoDB TTL always has.
	GetSession(ctx context.Context, token string) (*Session, error)
	// DeleteSession revokes a token before its natural expiry (logout, or
	// responding to a suspected leak). Idempotent: deleting an
	// already-gone or already-expired session succeeds, doesn't error.
	DeleteSession(ctx context.Context, token string) error
}
