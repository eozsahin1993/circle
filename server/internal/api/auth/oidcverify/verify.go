// Package oidcverify verifies OIDC ID tokens (Google Sign-In, Sign in with
// Apple) and extracts their claims — one generic implementation shared by
// both providers instead of a bespoke verifier per provider, since the
// underlying mechanism (a JWT signed by keys published at the provider's
// own JWKS URL) is identical.
package oidcverify

import (
	"errors"
	"fmt"

	"github.com/golang-jwt/jwt/v5"
)

// ErrEmailNotVerified means the provider itself didn't attest the email —
// an OIDC token can legally carry an unverified email claim, and trusting
// one here would defeat the entire point of using this as a registration
// credential.
var ErrEmailNotVerified = errors.New("oidcverify: email not verified")

// Claims is what a verified token yields. Sub is the provider's own
// permanent per-user identifier — required by the OIDC spec on every
// token, unlike Email (scope-gated, and the value itself can change: a
// user's account email, or an Apple private-relay address, at any time).
// Callers should key identity on Sub, not Email — see server/DESIGN.md's
// "Account recovery" section for why.
type Claims struct {
	Sub   string
	Email string
}

// Verifier checks ID tokens from one OIDC provider (issuer) against its
// published JWKS, and enforces that the token's audience is one this app
// actually issued — so a token minted for some other, unrelated
// application that happens to share the same identity provider can't be
// replayed here.
type Verifier struct {
	issuer    string
	audiences map[string]struct{}
	jwks      *jwks
}

// New constructs a Verifier for one provider. jwksURL's keys are fetched
// lazily on first use and cached (see jwks.go) — safe to construct once at
// process start and reuse for the process lifetime, same as every other
// adapter in this codebase.
func New(issuer, jwksURL string, audiences []string) *Verifier {
	audienceSet := make(map[string]struct{}, len(audiences))
	for _, a := range audiences {
		audienceSet[a] = struct{}{}
	}
	return &Verifier{issuer: issuer, audiences: audienceSet, jwks: newJWKS(jwksURL)}
}

// VerifyAndGetClaims validates rawToken's signature, issuer, audience, and
// expiry, then returns its Sub and verified Email.
func (v *Verifier) VerifyAndGetClaims(rawToken string) (Claims, error) {
	return verifyAndGetClaims(rawToken, v.jwks.keyFunc, v.issuer, v.audiences)
}

// verifyAndGetClaims is split out from the method above purely so tests can
// supply a fake keyFunc (a locally-generated RSA key signing a test token)
// instead of needing a real network call to Google/Apple's JWKS endpoint.
func verifyAndGetClaims(rawToken string, keyFunc jwt.Keyfunc, issuer string, audiences map[string]struct{}) (Claims, error) {
	// RS256 only — restricting accepted algorithms up front is standard
	// defense against JWT algorithm-confusion attacks (e.g. an attacker
	// crafting a token with "alg: none" or a symmetric algorithm that
	// happens to verify against public material).
	token, err := jwt.Parse(rawToken, keyFunc,
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(issuer),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return Claims{}, fmt.Errorf("oidcverify: %w", err)
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return Claims{}, errors.New("oidcverify: unexpected claims type")
	}

	if !audienceAccepted(claims, audiences) {
		return Claims{}, errors.New("oidcverify: audience not accepted")
	}

	sub, _ := claims["sub"].(string)
	if sub == "" {
		return Claims{}, errors.New("oidcverify: token has no sub claim")
	}

	email, _ := claims["email"].(string)
	if email == "" {
		return Claims{}, errors.New("oidcverify: token has no email claim")
	}
	if !emailVerifiedClaim(claims) {
		return Claims{}, ErrEmailNotVerified
	}
	return Claims{Sub: sub, Email: email}, nil
}

// audienceAccepted checks the token's aud claim (a string or array of
// strings, both legal per the JWT spec) against the configured set —
// written by hand rather than relying solely on jwt.WithAudience, because
// that only checks a single expected value and this app legitimately has
// more than one valid audience (Apple's iOS bundle ID and Services ID;
// Google's iOS/Android/Web client IDs).
func audienceAccepted(claims jwt.MapClaims, audiences map[string]struct{}) bool {
	switch aud := claims["aud"].(type) {
	case string:
		_, ok := audiences[aud]
		return ok
	case []any:
		for _, a := range aud {
			if s, ok := a.(string); ok {
				if _, accepted := audiences[s]; accepted {
					return true
				}
			}
		}
	}
	return false
}

// emailVerifiedClaim handles both representations providers actually send
// in practice: Google sends a real JSON boolean, Apple sends the string
// "true"/"false" — a documented quirk of Apple's identity tokens, not a
// bug in this code.
func emailVerifiedClaim(claims jwt.MapClaims) bool {
	switch v := claims["email_verified"].(type) {
	case bool:
		return v
	case string:
		return v == "true"
	default:
		return false
	}
}
