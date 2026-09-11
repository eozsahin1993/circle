// Package logout is the vertical slice for POST /v1/auth/logout: revokes
// the session token auth.Issue handed out, regardless of which provider
// (Apple or Google) signed the caller in.
package logout

import (
	"context"

	"circle-relay/internal/api/auth"
	"circle-relay/internal/storage/authstore"
)

type Service struct {
	AuthStore authstore.Store
}

// Logout revokes token immediately. Idempotent, same as the underlying
// DeleteSession — logging out an already-expired or already-revoked token
// isn't an error.
func (s *Service) Logout(ctx context.Context, token string) error {
	return auth.Revoke(ctx, s.AuthStore, token)
}
