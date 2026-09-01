// Package secrets defines the interface domain logic depends on for the
// app's KMS-protected root secret — implementations live in subpackages
// (see secrets/kms). Nothing storage- or runtime-specific is allowed to
// leak past this package.
package secrets

import "context"

// Store hands back the app's single KMS-protected root secret — see
// server/DESIGN.md's "Email auth" section and internal/crypto. One master
// KMS key, one root secret, one kms:Decrypt call per process; every
// feature that needs its own key (today just email-HMAC) derives one from
// this via internal/crypto.Derive instead of provisioning a new
// KMS-encrypted secret.
type Store interface {
	RootSecret(ctx context.Context) ([]byte, error)
}
