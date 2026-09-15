// Package auth groups everything specific to this app's auth domain: the
// Store interface and session state (store.go), the shared
// issuance/revocation logic and RequireSession middleware here and in
// middleware.go, generic OIDC token verification in auth/oidcverify, and
// one HTTP subpackage per supported sign-in provider (auth/http/google,
// auth/http/apple, auth/http/logout).
package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"
)

// TTL is deliberately long — re-signing-in on every app launch would be
// real friction for zero benefit; the token is what's revocable (see
// Revoke), not the underlying account.
const TTL = 90 * 24 * time.Hour

// Issue mints a fresh bearer token for accountID. The token, not accountID
// itself, is what the client uses on future requests — accountID is
// permanent and can't be rotated without banning the account outright, so
// it's kept as a server-internal identifier only. See Session's doc
// comment for the full reasoning.
func Issue(ctx context.Context, authStore Store, accountID string) (string, error) {
	token, err := generateToken()
	if err != nil {
		return "", err
	}
	if err := authStore.SaveSession(ctx, token, Session{
		AccountID: accountID,
		ExpiresAt: time.Now().Add(TTL),
	}); err != nil {
		return "", err
	}
	return token, nil
}

// Revoke deletes token immediately — logout, or responding to a suspected
// leak, without waiting out TTL.
func Revoke(ctx context.Context, authStore Store, token string) error {
	return authStore.DeleteSession(ctx, token)
}

// generateToken uses crypto/rand, not math/rand — a bearer token is the
// actual request credential, a predictable one defeats the entire point.
func generateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
