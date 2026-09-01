package oidcverify

import (
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// jwksCacheTTL bounds how long a fetched keyset is trusted before
// refetching — providers rotate signing keys periodically (Google and
// Apple both do), so a process-lifetime-only cache would eventually start
// rejecting valid tokens signed with a newly-rotated key.
const jwksCacheTTL = 6 * time.Hour

type jwk struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	N   string `json:"n"`
	E   string `json:"e"`
}

type jwksResponse struct {
	Keys []jwk `json:"keys"`
}

// jwks fetches and caches one provider's RSA public signing keys, keyed by
// kid — hand-rolled rather than pulling in a JWKS client library: parsing
// this handful of base64url fields into an rsa.PublicKey is simple, and
// the actual signature verification crypto is still done by golang-jwt
// against Go's own crypto/rsa, not reimplemented here.
type jwks struct {
	url string

	mu        sync.Mutex
	keys      map[string]*rsa.PublicKey
	fetchedAt time.Time
}

func newJWKS(url string) *jwks {
	return &jwks{url: url}
}

// keyFunc is a jwt.Keyfunc — looks up the signing key named by the token's
// own "kid" header.
func (j *jwks) keyFunc(token *jwt.Token) (any, error) {
	kid, ok := token.Header["kid"].(string)
	if !ok {
		return nil, errors.New("oidcverify: token header has no kid")
	}
	keys, err := j.get()
	if err != nil {
		return nil, err
	}
	key, ok := keys[kid]
	if !ok {
		return nil, fmt.Errorf("oidcverify: no key for kid %q", kid)
	}
	return key, nil
}

func (j *jwks) get() (map[string]*rsa.PublicKey, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.keys != nil && time.Since(j.fetchedAt) < jwksCacheTTL {
		return j.keys, nil
	}
	keys, err := fetchJWKS(j.url)
	if err != nil {
		if j.keys != nil {
			// Stale keys beat no keys — a transient fetch failure
			// shouldn't reject every sign-in until the next refresh.
			return j.keys, nil
		}
		return nil, err
	}
	j.keys = keys
	j.fetchedAt = time.Now()
	return keys, nil
}

func fetchJWKS(url string) (map[string]*rsa.PublicKey, error) {
	resp, err := http.Get(url)
	if err != nil {
		return nil, fmt.Errorf("oidcverify: fetching JWKS: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("oidcverify: JWKS fetch returned status %d", resp.StatusCode)
	}
	var parsed jwksResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("oidcverify: decoding JWKS: %w", err)
	}
	keys := make(map[string]*rsa.PublicKey, len(parsed.Keys))
	for _, k := range parsed.Keys {
		if k.Kty != "RSA" {
			continue
		}
		pub, err := rsaPublicKeyFromJWK(k)
		if err != nil {
			return nil, err
		}
		keys[k.Kid] = pub
	}
	return keys, nil
}

func rsaPublicKeyFromJWK(k jwk) (*rsa.PublicKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(k.N)
	if err != nil {
		return nil, fmt.Errorf("oidcverify: decoding JWK modulus: %w", err)
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(k.E)
	if err != nil {
		return nil, fmt.Errorf("oidcverify: decoding JWK exponent: %w", err)
	}
	return &rsa.PublicKey{
		N: new(big.Int).SetBytes(nBytes),
		E: int(new(big.Int).SetBytes(eBytes).Int64()),
	}, nil
}
