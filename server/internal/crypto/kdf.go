package crypto

import (
	"crypto/sha256"
	"io"

	"golang.org/x/crypto/hkdf"
)

// Derive returns a 32-byte key derived from rootSecret, scoped to purpose —
// distinct purposes can never collide or be confused for one another, and
// compromising one derived key doesn't reveal rootSecret or any sibling key.
func Derive(rootSecret []byte, purpose string) ([]byte, error) {
	key := make([]byte, 32)
	r := hkdf.New(sha256.New, rootSecret, nil, []byte(purpose))
	if _, err := io.ReadFull(r, key); err != nil {
		return nil, err
	}
	return key, nil
}
