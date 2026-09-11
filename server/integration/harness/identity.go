package harness

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
)

// Suffix is an id nothing else will use — for an account, a token, an
// invite tag, or a set of table names. Resource-name safe: lowercase hex,
// short enough for S3's 63-character bucket limit.
func Suffix() string {
	buf := make([]byte, 8)
	// crypto/rand.Read is documented never to return an error.
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

// Ciphertext stands in for whatever a client would have encrypted. Random
// because the relay is blind to an entry's body — it never reads these
// bytes. What it does verify, for the operations that carry one, is an
// authority signature: that's real Ed25519 over a real message, once a
// test needs it (authority changes, rotate) — see logstore.AuthorityChange
// for the message format a keypair helper here would need to match.
func Ciphertext() string {
	buf := make([]byte, 64)
	_, _ = rand.Read(buf)
	return base64.StdEncoding.EncodeToString(buf)
}
