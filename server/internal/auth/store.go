package auth

import (
	"context"
	"strings"
	"time"
)

// Session is what a bearer token resolves to. Deliberately not the
// accountId itself: the accountId is permanent (see auth/http/google's
// SignIn — "provider:sub", never rotated), so using it directly as the
// request credential would mean no way to revoke or rotate access without
// banning the account outright. A session token is random and
// independently revocable/expirable — "who you are" and "what currently
// authorizes you" are different things.
type Session struct {
	AccountID string
	ExpiresAt time.Time
}

// Store is the interface domain logic depends on for session state,
// keyed by bearer token; implementations live in subpackages, one per
// backing technology (see auth/dynamodb). Nothing storage- or
// runtime-specific is allowed to leak past this package.
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
	// DeleteAllSessions revokes every session for accountID, not just one
	// token — account deletion's own call, so a different device's still
	// live session can't outlive the account it belonged to. Idempotent,
	// same as DeleteSession.
	DeleteAllSessions(ctx context.Context, accountID string) error
}

// AppleProvider namespaces Apple-issued account ids — see auth/http/apple
// for why identity is keyed "<provider>:<sub>". Named here rather than
// there so account deletion can recognize an Apple account without
// importing a sign-in endpoint's package for a string.
const AppleProvider = "apple"

// IsAppleAccount reports whether accountID came from Sign in with Apple,
// and so may have a grant to revoke when the account is deleted.
func IsAppleAccount(accountID string) bool {
	return strings.HasPrefix(accountID, AppleProvider+":")
}

// AppleCredentialStore persists one Apple refresh token per account, kept
// for exactly one purpose: spending it on a revoke when the account is
// deleted (App Store Review Guideline 5.1.1(v) — see internal/auth/appleid).
// Never TTL'd, since an account may be deleted years after it signs in.
//
// This is the only provider credential the relay stores. It grants no
// access to anything in a circle — the relay can't read those either —
// but it is real Apple-side authority, so it's written once at sign-in
// and deleted the moment deletion has used it.
type AppleCredentialStore interface {
	// SaveAppleRefreshToken replaces whatever was stored for accountID —
	// a later sign-in's token supersedes an earlier one, and either works
	// for revocation.
	SaveAppleRefreshToken(ctx context.Context, accountID, refreshToken string) error
	// GetAppleRefreshToken returns "" when nothing is stored: an account
	// that signed in before this existed, or one whose code exchange
	// failed. Not an error — there's simply nothing to revoke.
	GetAppleRefreshToken(ctx context.Context, accountID string) (string, error)
	// DeleteAppleRefreshToken removes it. Idempotent.
	DeleteAppleRefreshToken(ctx context.Context, accountID string) error
}
