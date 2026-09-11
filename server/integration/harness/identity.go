package harness

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"testing"
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
// authority signature, and that can't be faked the same way: see
// Authority.
func Ciphertext() string {
	buf := make([]byte, 64)
	_, _ = rand.Read(buf)
	return base64.StdEncoding.EncodeToString(buf)
}

// Authority is an admin's ed25519 keypair — what the relay checks a
// rotation, a promotion or a deletion against. Real crypto, not a stand-in
// like Ciphertext: these are the operations the relay does verify, and a
// test that faked the signature would only ever exercise the rejection
// path.
type Authority struct {
	public  ed25519.PublicKey
	private ed25519.PrivateKey
}

func NewAuthority(t *testing.T) Authority {
	t.Helper()
	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("failed to generate an authority key: %v", err)
	}
	return Authority{public: public, private: private}
}

// PublicKey is the hex form every relay field carrying an authority key expects.
func (a Authority) PublicKey() string { return hex.EncodeToString(a.public) }

// Sign covers message — build it with the logstore constructor for the
// operation (RotateMessage, AuthorityChange.Message, ...) rather than by
// hand, so a test can't pass by reproducing a mistake the relay also makes.
func (a Authority) Sign(message []byte) string {
	return hex.EncodeToString(ed25519.Sign(a.private, message))
}

// WriteToken is a circle's write capability and the only half of it the
// relay ever stores. Hex because the relay hex-decodes the token before
// hashing it, so a token that isn't hex can never match anything.
type WriteToken struct {
	Token string
	Hash  string
}

func NewWriteToken() WriteToken {
	raw := make([]byte, 32)
	_, _ = rand.Read(raw)
	sum := sha256.Sum256(raw)
	return WriteToken{Token: hex.EncodeToString(raw), Hash: hex.EncodeToString(sum[:])}
}
