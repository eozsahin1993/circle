package oidcverify

import (
	"crypto/rand"
	"crypto/rsa"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// testKeyFunc always returns pub, ignoring the token's kid — real provider
// verification looks the key up by kid (see jwks.go); that lookup logic is
// simple enough not to need its own test here, so tests exercise
// verifyAndGetEmail directly against a known key instead of hitting a real
// network JWKS endpoint.
func testKeyFunc(pub *rsa.PublicKey) jwt.Keyfunc {
	return func(*jwt.Token) (any, error) { return pub, nil }
}

func signTestToken(t *testing.T, key *rsa.PrivateKey, claims jwt.MapClaims) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

func baseClaims() jwt.MapClaims {
	return jwt.MapClaims{
		"iss":            "https://issuer.example",
		"aud":            "client-id-1",
		"email":          "person@example.com",
		"email_verified": true,
		"exp":            time.Now().Add(time.Hour).Unix(),
		"iat":            time.Now().Unix(),
	}
}

func testKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func TestVerifyAndGetEmail_ValidTokenReturnsEmail(t *testing.T) {
	key := testKey(t)
	token := signTestToken(t, key, baseClaims())

	email, err := verifyAndGetEmail(token, testKeyFunc(&key.PublicKey), "https://issuer.example",
		map[string]struct{}{"client-id-1": {}})
	if err != nil {
		t.Fatal(err)
	}
	if email != "person@example.com" {
		t.Fatalf("expected person@example.com, got %q", email)
	}
}

func TestVerifyAndGetEmail_AppleStyleStringEmailVerifiedIsAccepted(t *testing.T) {
	key := testKey(t)
	claims := baseClaims()
	claims["email_verified"] = "true"
	token := signTestToken(t, key, claims)

	if _, err := verifyAndGetEmail(token, testKeyFunc(&key.PublicKey), "https://issuer.example",
		map[string]struct{}{"client-id-1": {}}); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyAndGetEmail_UnverifiedEmailIsRejected(t *testing.T) {
	key := testKey(t)
	claims := baseClaims()
	claims["email_verified"] = false
	token := signTestToken(t, key, claims)

	_, err := verifyAndGetEmail(token, testKeyFunc(&key.PublicKey), "https://issuer.example",
		map[string]struct{}{"client-id-1": {}})
	if err != ErrEmailNotVerified {
		t.Fatalf("expected ErrEmailNotVerified, got %v", err)
	}
}

func TestVerifyAndGetEmail_WrongAudienceIsRejected(t *testing.T) {
	key := testKey(t)
	token := signTestToken(t, key, baseClaims())

	_, err := verifyAndGetEmail(token, testKeyFunc(&key.PublicKey), "https://issuer.example",
		map[string]struct{}{"some-other-client-id": {}})
	if err == nil {
		t.Fatal("expected an error for an unaccepted audience")
	}
}

func TestVerifyAndGetEmail_ArrayAudienceIsAccepted(t *testing.T) {
	key := testKey(t)
	claims := baseClaims()
	claims["aud"] = []string{"some-other-client-id", "client-id-1"}
	token := signTestToken(t, key, claims)

	if _, err := verifyAndGetEmail(token, testKeyFunc(&key.PublicKey), "https://issuer.example",
		map[string]struct{}{"client-id-1": {}}); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyAndGetEmail_WrongIssuerIsRejected(t *testing.T) {
	key := testKey(t)
	claims := baseClaims()
	claims["iss"] = "https://not-the-real-issuer.example"
	token := signTestToken(t, key, claims)

	_, err := verifyAndGetEmail(token, testKeyFunc(&key.PublicKey), "https://issuer.example",
		map[string]struct{}{"client-id-1": {}})
	if err == nil {
		t.Fatal("expected an error for a mismatched issuer")
	}
}

func TestVerifyAndGetEmail_ExpiredTokenIsRejected(t *testing.T) {
	key := testKey(t)
	claims := baseClaims()
	claims["exp"] = time.Now().Add(-time.Hour).Unix()
	token := signTestToken(t, key, claims)

	_, err := verifyAndGetEmail(token, testKeyFunc(&key.PublicKey), "https://issuer.example",
		map[string]struct{}{"client-id-1": {}})
	if err == nil {
		t.Fatal("expected an error for an expired token")
	}
}

func TestVerifyAndGetEmail_WrongSigningKeyIsRejected(t *testing.T) {
	signingKey := testKey(t)
	otherKey := testKey(t)
	token := signTestToken(t, signingKey, baseClaims())

	// Verifying against a different public key than the one that actually
	// signed the token must fail — this is the core forgery-prevention
	// property the whole package exists for.
	_, err := verifyAndGetEmail(token, testKeyFunc(&otherKey.PublicKey), "https://issuer.example",
		map[string]struct{}{"client-id-1": {}})
	if err == nil {
		t.Fatal("expected an error when verifying against the wrong public key")
	}
}
