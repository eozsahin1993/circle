// Package google is the vertical slice for POST /v1/auth/google — see
// server/DESIGN.md's "Email auth" section.
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
// values, independently issued by unrelated ID spaces, can never collide
// — see server/DESIGN.md's "Account recovery" section for why identity is
// keyed on sub, not email.
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
