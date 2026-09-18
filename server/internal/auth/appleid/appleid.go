// Package appleid talks to Apple's own token endpoints — the half of
// Sign in with Apple that isn't ID-token verification (that half is
// internal/auth/oidcverify, and needs no credentials of ours at all).
//
// It exists for one requirement: App Store Review Guideline 5.1.1(v)
// makes deleting an account also revoke the Sign in with Apple grant
// behind it, or the app keeps showing under Settings › Apple Account ›
// Sign in with Apple after the account it belonged to is gone. Apple
// won't revoke an identity token, only a refresh token, so sign-in
// exchanges the client's one-time authorization code for one and the
// relay keeps it until deletion spends it (see auth.AppleCredentialStore).
package appleid

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// DefaultBaseURL is Apple's token host. Overridable on Client only so
// tests can point at a local stand-in.
const DefaultBaseURL = "https://appleid.apple.com"

// clientSecretLifetime is well under Apple's six-month cap: this secret is
// minted for one request and thrown away, so nothing gains from a long one.
const clientSecretLifetime = 5 * time.Minute

// The three failures a caller can act on, as sentinels rather than
// strings — same shape as oidcverify's. They're worth telling apart
// because only one of them is anyone's fault: a key that won't load is a
// misconfigured environment and needs a person, where a rejected code is
// routine (Apple expires them in minutes) and an unreachable Apple is
// weather.
var (
	ErrKeyUnavailable = errors.New("appleid: signing key unavailable")
	ErrRejected       = errors.New("appleid: Apple rejected the request")
	ErrUnreachable    = errors.New("appleid: Apple unreachable")
)

// Reason classifies a failure for logging: a small, fixed vocabulary, so
// the log line can be filtered and counted rather than grepped. Never
// includes the code, the token, or the key.
func Reason(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrKeyUnavailable):
		return "apple_key_unavailable"
	case errors.Is(err, ErrRejected):
		return "apple_rejected"
	case errors.Is(err, ErrUnreachable):
		return "apple_unreachable"
	default:
		return "unknown"
	}
}

// Key is what signing a client secret takes. ClientID is the audience
// Apple issued the grant to — the app's bundle id, the same value
// config.AppleClientIDIOS carries for token verification.
type Key struct {
	KeyID      string
	TeamID     string
	ClientID   string
	PrivateKey string // PEM, ES256 (.p8)
}

// Client calls Apple's /auth/token and /auth/revoke endpoints.
//
// LoadKey is a func rather than a Key so the .p8 can come from SSM on
// first use — a relay whose users all signed in with Google never reads
// the parameter at all. See NewClient.
type Client struct {
	LoadKey    func(ctx context.Context) (Key, error)
	BaseURL    string
	HTTPClient *http.Client
}

func (c *Client) baseURL() string {
	if c.BaseURL == "" {
		return DefaultBaseURL
	}
	return c.BaseURL
}

func (c *Client) httpClient() *http.Client {
	if c.HTTPClient == nil {
		return http.DefaultClient
	}
	return c.HTTPClient
}

// ExchangeCode trades the client's one-time authorization code for a
// refresh token. The code is short-lived (minutes) and single-use, which
// is why this runs during sign-in rather than being deferred to deletion:
// by then the code the client captured is long dead.
func (c *Client) ExchangeCode(ctx context.Context, code string) (string, error) {
	key, secret, err := c.credentials(ctx)
	if err != nil {
		return "", err
	}

	body, err := c.post(ctx, "/auth/token", url.Values{
		"client_id":     {key.ClientID},
		"client_secret": {secret},
		"code":          {code},
		"grant_type":    {"authorization_code"},
	})
	if err != nil {
		return "", err
	}

	var parsed struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("%w: decode the token response: %w", ErrRejected, err)
	}
	if parsed.RefreshToken == "" {
		return "", fmt.Errorf("%w: no refresh token in the token response", ErrRejected)
	}
	return parsed.RefreshToken, nil
}

// Revoke invalidates the grant behind refreshToken — the call Guideline
// 5.1.1(v) is actually about. Apple answers 200 with an empty body, and
// treats revoking an already-revoked token as success.
func (c *Client) Revoke(ctx context.Context, refreshToken string) error {
	key, secret, err := c.credentials(ctx)
	if err != nil {
		return err
	}

	_, err = c.post(ctx, "/auth/revoke", url.Values{
		"client_id":       {key.ClientID},
		"client_secret":   {secret},
		"token":           {refreshToken},
		"token_type_hint": {"refresh_token"},
	})
	return err
}

func (c *Client) credentials(ctx context.Context) (Key, string, error) {
	key, err := c.LoadKey(ctx)
	if err != nil {
		return Key{}, "", fmt.Errorf("%w: %w", ErrKeyUnavailable, err)
	}
	secret, err := clientSecret(key)
	if err != nil {
		return Key{}, "", fmt.Errorf("%w: %w", ErrKeyUnavailable, err)
	}
	return key, secret, nil
}

func (c *Client) post(ctx context.Context, path string, form url.Values) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL()+path, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: call %s: %w", ErrUnreachable, path, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if err != nil {
		return nil, fmt.Errorf("%w: read %s response: %w", ErrUnreachable, path, err)
	}
	if resp.StatusCode != http.StatusOK {
		// Apple's error body is a short {"error":"..."} code, no user data
		// in it — safe to quote, and the code is the only way to tell an
		// expired authorization code (invalid_grant, routine) from a
		// client secret Apple won't accept (invalid_client, act on it).
		return nil, fmt.Errorf("%w: %s returned %d: %s", ErrRejected, path, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return body, nil
}

// clientSecret is the ES256 JWT Apple takes in place of a static secret —
// same shape as the APNs provider token (internal/push/apns/token.go) but
// a different key, a different audience, and a subject APNs has no
// equivalent of.
func clientSecret(key Key) (string, error) {
	if key.KeyID == "" || key.TeamID == "" || key.ClientID == "" {
		return "", fmt.Errorf("APPLE_SIGNIN_KEY_ID, APPLE_SIGNIN_TEAM_ID and APPLE_CLIENT_ID_IOS must all be set")
	}

	parsed, err := jwt.ParseECPrivateKeyFromPEM([]byte(key.PrivateKey))
	if err != nil {
		// Not wrapped: the parse error quotes its input, which is the key.
		return "", fmt.Errorf("Sign in with Apple key is not valid PEM")
	}

	now := time.Now()
	token := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{
		"iss": key.TeamID,
		"iat": now.Unix(),
		"exp": now.Add(clientSecretLifetime).Unix(),
		"aud": DefaultBaseURL,
		"sub": key.ClientID,
	})
	token.Header["kid"] = key.KeyID

	signed, err := token.SignedString(parsed)
	if err != nil {
		return "", fmt.Errorf("sign Apple client secret: %w", err)
	}
	return signed, nil
}
