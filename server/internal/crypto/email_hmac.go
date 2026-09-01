// Package crypto holds this app's key-derivation (internal/crypto.Derive)
// and the purpose-specific values built from it — kept in exactly one
// place so every caller (Google sign-in, Apple sign-in, anything added
// later) can never end up computing one differently for the same input,
// which would be a real, subtle bug (two providers, same person, two
// different deviceIds).
package crypto

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"

	"circle-relay/internal/secrets"
)

// emailHMACPurpose scopes the derived key to this one use — see Derive's
// doc comment.
const emailHMACPurpose = "email-hmac"

// EmailHMAC derives the durable device identifier for email — see
// server/DESIGN.md's "Email auth" section. This value IS the deviceId;
// there's no separate deviceId concept layered on top.
func EmailHMAC(ctx context.Context, secretStore secrets.Store, email string) (string, error) {
	root, err := secretStore.RootSecret(ctx)
	if err != nil {
		return "", err
	}
	key, err := Derive(root, emailHMACPurpose)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(email))
	return hex.EncodeToString(mac.Sum(nil)), nil
}
