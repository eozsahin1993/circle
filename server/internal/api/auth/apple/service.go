// Package apple is the vertical slice for POST /v1/auth/apple — see
// server/DESIGN.md's "Email auth" section.
package apple

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

// SignIn verifies idToken against Apple's own signing keys, then confirms
// the device and issues a bearer token for the token's verified email.
// Note: Apple only includes the email claim on a user's *first*
// authorization for this app unless the client explicitly re-requests it —
// the client is responsible for sending a token that actually carries the
// claim; this service has no fallback if it's missing.
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
