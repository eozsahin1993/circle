// Package auth groups everything specific to this app's auth domain: the
// shared session-issuance/revocation logic here, generic OIDC token
// verification in auth/oidcverify, and one subpackage per supported
// sign-in provider (auth/google, auth/apple, auth/logout).
package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"

	"circle-relay/internal/storage/authstore"
)

// TTL is deliberately long — re-signing-in on every app launch would be
// real friction for zero benefit; the token is what's revocable (see
// Revoke), not the underlying device registration.
const TTL = 90 * 24 * time.Hour

// Issue mints a fresh bearer token for emailHmac. The token, not emailHmac
// itself, is what the client uses on future requests — emailHmac is
// permanent and can't be rotated without banning the email address
// outright, so it's kept as a server-internal identifier only. See
// authstore.Session's doc comment for the full reasoning.
func Issue(ctx context.Context, authStore authstore.Store, emailHmac string) (string, error) {
	token, err := generateToken()
	if err != nil {
		return "", err
	}
	if err := authStore.SaveSession(ctx, token, authstore.Session{
		DeviceID:  emailHmac,
		ExpiresAt: time.Now().Add(TTL),
	}); err != nil {
		return "", err
	}
	return token, nil
}

// Revoke deletes token immediately — logout, or responding to a suspected
// leak, without waiting out TTL.
func Revoke(ctx context.Context, authStore authstore.Store, token string) error {
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
