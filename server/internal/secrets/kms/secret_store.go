// Package kms implements secrets.Store via standard KMS envelope
// encryption — see server/DESIGN.md's "Email auth" section. This is
// the first pass only (decrypt once via kms:Decrypt, cache in memory for
// the process lifetime), not the attestation-gated enclave the design
// calls out as deferred, later work.
package kms

import (
	"context"
	"encoding/base64"
	"fmt"
	"sync"

	"github.com/aws/aws-sdk-go-v2/service/kms"

	"circle-relay/internal/secrets"
)

type Store struct {
	client         *kms.Client
	ciphertextBlob []byte

	once   sync.Once
	secret []byte
	err    error
}

// New decodes ciphertextB64 once up front — ROOT_SECRET_CIPHERTEXT is
// base64 because that's safe to sit in a plain env var: useless without
// the KMS key that encrypted it.
func New(client *kms.Client, ciphertextB64 string) (*Store, error) {
	blob, err := base64.StdEncoding.DecodeString(ciphertextB64)
	if err != nil {
		return nil, fmt.Errorf("decoding root secret ciphertext: %w", err)
	}
	return &Store{client: client, ciphertextBlob: blob}, nil
}

var _ secrets.Store = (*Store)(nil)

// RootSecret calls kms:Decrypt exactly once per process — real API cost,
// not something to pay per-request — and caches the result. Every
// purpose-specific key (internal/crypto.Derive) is computed from this.
func (s *Store) RootSecret(ctx context.Context) ([]byte, error) {
	s.once.Do(func() {
		out, err := s.client.Decrypt(ctx, &kms.DecryptInput{CiphertextBlob: s.ciphertextBlob})
		if err != nil {
			s.err = err
			return
		}
		s.secret = out.Plaintext
	})
	return s.secret, s.err
}
