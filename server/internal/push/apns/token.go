// Package apns sends push notifications through Apple's HTTP/2 provider
// API. Alert pushes go out for real, but until the client ships a
// Notification Service Extension, every device shows only the fixed
// placeholder text, never the real content.
//
// iOS only. Android goes through FCM instead — see internal/push/fcm.
package apns

import (
	"fmt"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	// providerTokenLifetime stays under Apple's one-hour cap, refreshed
	// early so a send never races the expiry it just checked.
	providerTokenLifetime = 50 * time.Minute
	refreshMargin         = 5 * time.Minute
)

// tokenSource mints and caches an APNs provider token: an ES256 JWT signed
// with the auth key. Unlike fcm.tokenSource there's no exchange round
// trip — APNs accepts the signed assertion itself as the bearer token.
type tokenSource struct {
	key *AuthKey

	mu        sync.Mutex
	token     string
	expiresAt time.Time
}

func (s *tokenSource) providerToken() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.token != "" && time.Now().Before(s.expiresAt.Add(-refreshMargin)) {
		return s.token, nil
	}

	key, err := jwt.ParseECPrivateKeyFromPEM([]byte(s.key.PrivateKey))
	if err != nil {
		// Not wrapped: the parse error quotes its input, which is the key.
		return "", fmt.Errorf("APNs auth key is not valid PEM")
	}

	now := time.Now()
	token := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{
		"iss": s.key.TeamID,
		"iat": now.Unix(),
	})
	token.Header["kid"] = s.key.KeyID

	signed, err := token.SignedString(key)
	if err != nil {
		return "", fmt.Errorf("sign apns token: %w", err)
	}

	s.token = signed
	s.expiresAt = now.Add(providerTokenLifetime)
	return signed, nil
}
