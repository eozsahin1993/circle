// Package google is the vertical slice for POST /v1/auth/google: verifies
// the client's Google ID token against Google's own signing keys and issues
// this relay's own bearer token for the verified subject.
package google

import (
	"context"

	"circle-relay/internal/api/auth"
	"circle-relay/internal/api/auth/oidcverify"
	"circle-relay/internal/storage/authstore"
)

type Service struct {
	AuthStore authstore.Store
	Verifier  *oidcverify.Verifier
}

// providerName namespaces the accountID so Google's and Apple's sub
// values, independently issued by unrelated ID spaces, can never collide.
// Identity is keyed on sub, not email: sub is guaranteed stable and
// present on every token, while email can be withheld, relayed through
// Apple's private-relay address, or changed later.
const providerName = "google"

// SignIn verifies idToken against Google's own signing keys, then issues a
// bearer token for the token's verified subject — same downstream session
// machinery the apple package uses, just a different provider verifying
// the token up front.
func (s *Service) SignIn(ctx context.Context, idToken string) (string, error) {
	claims, err := s.Verifier.VerifyAndGetClaims(idToken)
	if err != nil {
		return "", err
	}

	accountID := providerName + ":" + claims.Sub
	return auth.Issue(ctx, s.AuthStore, accountID)
}
