package testsupport

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

// TestGoogleClientID and TestAppleClientID are the audiences NewRouter's
// fake providers accept — arbitrary, but shared between router construction
// and token-signing so tests don't have to keep the two in sync by hand.
const (
	TestGoogleClientID = "test-google-client-id"
	TestAppleClientID  = "test-apple-client-id"
)

// FakeOIDCProvider is a test-only stand-in for a real OIDC provider
// (Google, Apple): a local HTTP server serving a JWKS document for a
// locally generated key pair. Router/service-level tests exercise the
// real internal/oidcverify.Verifier code path — a real HTTP fetch, a real
// JWT parse — without depending on Google's or Apple's actual
// infrastructure being reachable from a test run.
type FakeOIDCProvider struct {
	Issuer  string
	JWKSURL string

	key *rsa.PrivateKey
	kid string
}

func NewFakeOIDCProvider(t testing.TB, issuer string) *FakeOIDCProvider {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const kid = "test-key-1"

	mux := http.NewServeMux()
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"keys": []map[string]string{{
				"kty": "RSA",
				"kid": kid,
				"n":   base64.RawURLEncoding.EncodeToString(key.PublicKey.N.Bytes()),
				"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes()),
			}},
		})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	return &FakeOIDCProvider{Issuer: issuer, JWKSURL: server.URL + "/jwks", key: key, kid: kid}
}

// SignToken signs claims as this fake provider. Callers are responsible for
// setting "iss", "aud", "email", "email_verified", "exp" as the test needs.
func (p *FakeOIDCProvider) SignToken(t testing.TB, claims jwt.MapClaims) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = p.kid
	signed, err := token.SignedString(p.key)
	if err != nil {
		t.Fatal(err)
	}
	return signed
}
