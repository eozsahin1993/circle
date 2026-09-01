// Package google is the vertical slice for POST /v1/auth/google — see
// server/DESIGN.md's "Email auth" section.
package google

import (
	"context"

	"circle-relay/internal/api/auth"
	"circle-relay/internal/api/auth/oidcverify"
	"circle-relay/internal/crypto"
	"circle-relay/internal/secrets"
	"circle-relay/internal/storage/authstore"
)

type Service struct {
	Secrets   secrets.Store
	AuthStore authstore.Store
	Verifier  *oidcverify.Verifier
}

// SignIn verifies idToken against Google's own signing keys, then confirms
// the device and issues a bearer token for the token's verified email —
// same downstream session machinery the apple package uses, just a
// different provider verifying the email up front.
func (s *Service) SignIn(ctx context.Context, idToken string) (string, error) {
	email, err := s.Verifier.VerifyAndGetEmail(idToken)
	if err != nil {
		return "", err
	}

	emailHmac, err := crypto.EmailHMAC(ctx, s.Secrets, email)
	if err != nil {
		return "", err
	}

	return auth.Issue(ctx, s.AuthStore, emailHmac)
}
