package synclog

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// WriteTokenHash hashes a hex-encoded write token the same way the relay
// compares it against what's on file — sha256 over the raw bytes the hex
// decodes to. Exported so a test can build the exact hash a real write
// would produce without reaching into a specific adapter's own copy of
// this.
func WriteTokenHash(writeTokenHex string) (string, error) {
	raw, err := hex.DecodeString(writeTokenHex)
	if err != nil {
		return "", fmt.Errorf("write token is not valid hex: %w", err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

// VerifySignature checks cryptographic validity only — whether
// authorityPublicKeyHex is actually a key a circle currently recognizes
// is a separate, storage-backed check (see LogStore.VerifyAuthoritySignature).
// ed25519.Verify panics on a wrong-length key or signature rather than
// returning false, so lengths are validated first — a malformed request
// must fail cleanly, not crash the process.
func VerifySignature(authorityPublicKeyHex string, message []byte, signature []byte) error {
	pubKey, err := hex.DecodeString(authorityPublicKeyHex)
	if err != nil || len(pubKey) != ed25519.PublicKeySize {
		return ErrInvalidSignature
	}
	if len(signature) != ed25519.SignatureSize {
		return ErrInvalidSignature
	}
	if !ed25519.Verify(ed25519.PublicKey(pubKey), message, signature) {
		return ErrInvalidSignature
	}
	return nil
}

// ValidPublicKey checks a key being written *into* the authority set,
// which no signature covers — the key's owner isn't the one calling.
// Nothing can sign as a malformed one, so it could never remove itself
// again.
func ValidPublicKey(publicKeyHex string) bool {
	raw, err := hex.DecodeString(publicKeyHex)
	return err == nil && len(raw) == ed25519.PublicKeySize
}
