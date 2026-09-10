// Package fcm sends push notifications through Firebase Cloud Messaging's
// HTTP v1 API — see server/PUSH_DESIGN.md.
//
// Android only. iOS goes direct to APNs rather than through FCM, so that
// Google isn't in the path of iOS delivery metadata for no benefit.
package fcm

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	scope             = "https://www.googleapis.com/auth/firebase.messaging"
	defaultTokenURI   = "https://oauth2.googleapis.com/token"
	assertionLifetime = time.Hour
	// Refreshed early so a send never races the expiry it just checked.
	refreshMargin = 5 * time.Minute
)

// tokenSource mints and caches Google access tokens from a service-account
// key, the JWT-bearer flow: sign an assertion with the private key, trade
// it for an access token.
//
// Cached because a token lasts an hour and a Lambda serves many sends per
// cold start; minting per send would add a round trip to every push.
type tokenSource struct {
	account *ServiceAccount
	client  *http.Client

	mu        sync.Mutex
	token     string
	expiresAt time.Time
}

func (s *tokenSource) accessToken(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.token != "" && time.Now().Before(s.expiresAt.Add(-refreshMargin)) {
		return s.token, nil
	}

	assertion, err := s.signAssertion()
	if err != nil {
		return "", err
	}

	token, lifetime, err := s.exchange(ctx, assertion)
	if err != nil {
		return "", err
	}

	s.token = token
	s.expiresAt = time.Now().Add(lifetime)
	return token, nil
}

func (s *tokenSource) signAssertion() (string, error) {
	key, err := jwt.ParseRSAPrivateKeyFromPEM([]byte(s.account.PrivateKey))
	if err != nil {
		// Not wrapped: the parse error quotes its input, which is the key.
		return "", fmt.Errorf("service-account private key is not valid PEM")
	}

	now := time.Now()
	claims := jwt.MapClaims{
		"iss":   s.account.ClientEmail,
		"scope": scope,
		"aud":   s.tokenURI(),
		"iat":   now.Unix(),
		"exp":   now.Add(assertionLifetime).Unix(),
	}

	signed, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(key)
	if err != nil {
		return "", fmt.Errorf("sign assertion: %w", err)
	}
	return signed, nil
}

func (s *tokenSource) exchange(ctx context.Context, assertion string) (string, time.Duration, error) {
	form := url.Values{
		"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"},
		"assertion":  {assertion},
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.tokenURI(), strings.NewReader(form.Encode()))
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := s.client.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("exchange assertion: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("exchange assertion: %s", resp.Status)
	}

	var body struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", 0, fmt.Errorf("decode token response: %w", err)
	}
	if body.AccessToken == "" {
		return "", 0, fmt.Errorf("token response carried no access_token")
	}
	return body.AccessToken, time.Duration(body.ExpiresIn) * time.Second, nil
}

func (s *tokenSource) tokenURI() string {
	if s.account.TokenURI != "" {
		return s.account.TokenURI
	}
	return defaultTokenURI
}
