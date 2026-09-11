// Package blackbox_test drives the relay the way a client does: over HTTP,
// with no access to anything inside it.
//
// The point isn't coverage the in-process tests lack — internal/api's own
// tests already exercise every handler against real storage. It's that
// these are *sequences*. A client's real problems live between calls:
// create an invite, request against it, approve, then find the approval is
// readable when it shouldn't be. Nothing in the suite today carries state
// from one call to the next.
//
// Two properties make that safe to write. The relay is blind (SYNC_DESIGN
// invariant 3), so an entry body can be any bytes at all — no client
// crypto to reproduce here, and nothing to drift out of step with the app.
// And rows are isolated by unique ids rather than by teardown, the same
// way testsupport does it, so tests share one LocalStack without ordering
// between them.
package blackbox_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"

	"circle-relay/internal/api"
	"circle-relay/internal/app"
	"circle-relay/internal/config"
	"circle-relay/internal/localstack"
	"circle-relay/internal/storage/authstore"
)

// sessionTTL only has to outlast one test.
const sessionTTL = time.Hour

// relay is a running relay and the means to talk to it.
type relay struct {
	baseURL string
	// sessions is how a test gets a bearer token. Written directly rather
	// than through a test-only HTTP route: this suite holds the store, and
	// a route that mints sessions is something cmd/testrelay needs only
	// because the app can't reach into the relay's process.
	sessions authstore.Store
}

var (
	shared    *relay
	sharedErr error
	sharedOne sync.Once
)

// start returns the relay every test in this package shares.
//
// httptest.NewServer, not the mux directly: that gives a real listener on
// a real port, so these requests cross an actual socket and go through
// net/http's own parsing rather than being handed to a handler. Set
// RELAY_URL to aim the same tests at a running cmd/testrelay, or at a
// deployed stack.
func start(t *testing.T) *relay {
	t.Helper()
	sharedOne.Do(func() { shared, sharedErr = buildRelay() })
	if sharedErr != nil {
		t.Skipf("LocalStack not reachable, skipping: %v", sharedErr)
	}
	return shared
}

func buildRelay() (*relay, error) {
	ctx := context.Background()

	awsCfg, err := localstack.Config(ctx)
	if err != nil {
		return nil, err
	}

	s3Client := awss3.NewFromConfig(awsCfg, func(o *awss3.Options) { o.UsePathStyle = true })
	if err := localstack.Provision(ctx, awsdynamodb.NewFromConfig(awsCfg), s3Client); err != nil {
		return nil, err
	}

	deps := app.Deps(relayConfig(), awsCfg)

	baseURL := os.Getenv("RELAY_URL")
	if baseURL == "" {
		server := httptest.NewServer(api.NewRouter(deps))
		baseURL = server.URL
	}

	return &relay{baseURL: baseURL, sessions: deps.Auth}, nil
}

// relayConfig mirrors config.Load's shape without the environment. Rate
// limits stay at their production defaults, unlike testsupport's million —
// each test signs in as its own account, so they each get a whole budget
// and nothing here has to dodge the limiter.
func relayConfig() config.Config {
	return config.Config{
		TableName:                 localstack.LogTable,
		BucketName:                localstack.BlobBucket,
		SessionsTableName:         localstack.SessionsTable,
		AccountsTableName:         localstack.AccountsTable,
		InviteTableName:           localstack.InviteTable,
		RateLimitTableName:        localstack.RateLimitTable,
		PushTableName:             localstack.PushTable,
		RateLimitWriteMaxRequests: 500,
		RateLimitReadMaxRequests:  2000,
		RateLimitPushMaxRequests:  500,
		RateLimitWindowMinutes:    10,
		S3ForcePathStyle:          true,
	}
}

// device is one signed-in caller. Named for what it is on the relay's
// side: an account with a session, holding no circle state of its own.
type device struct {
	accountID string
	token     string
}

// signIn mints a session for a fresh account, skipping Google and Apple.
// Provider verification is internal/api's business; what matters here is
// that requests carry a credential the relay accepts.
func (r *relay) signIn(t *testing.T) *device {
	t.Helper()
	d := &device{accountID: "test:" + unique(t), token: unique(t)}
	session := authstore.Session{AccountID: d.accountID, ExpiresAt: time.Now().Add(sessionTTL)}
	if err := r.sessions.SaveSession(context.Background(), d.token, session); err != nil {
		t.Fatalf("failed to mint a session: %v", err)
	}
	return d
}

// response is one HTTP reply, kept whole so a test can assert on the
// status and the body without re-reading either.
type response struct {
	status int
	body   []byte
}

// json decodes the body into target, failing the test if it can't.
func (res response) json(t *testing.T, target any) {
	t.Helper()
	if err := json.Unmarshal(res.body, target); err != nil {
		t.Fatalf("failed to decode %q: %v", res.body, err)
	}
}

// expect fails unless the status matches, quoting the body — which is
// where the relay says why, and the first thing anyone wants when a
// black-box test goes red.
func (res response) expect(t *testing.T, status int) response {
	t.Helper()
	if res.status != status {
		t.Fatalf("got %d, want %d: %s", res.status, status, res.body)
	}
	return res
}

// do sends one request as d, or unauthenticated when d is nil.
func (r *relay) do(t *testing.T, d *device, method, path string, body any) response {
	t.Helper()

	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("failed to encode the request body: %v", err)
		}
		payload = bytes.NewReader(encoded)
	}

	req, err := http.NewRequest(method, r.baseURL+path, payload)
	if err != nil {
		t.Fatalf("failed to build the request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if d != nil {
		req.Header.Set("Authorization", "Bearer "+d.token)
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s failed: %v", method, path, err)
	}
	defer res.Body.Close()

	read, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("failed to read the response to %s %s: %v", method, path, err)
	}
	return response{status: res.StatusCode, body: read}
}

// unique is an id no other test will use, so tests share one LocalStack
// without taking turns. Hex of the test name would collide across a
// re-run; random bytes don't.
func unique(t *testing.T) string {
	t.Helper()
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		t.Fatalf("failed to read random bytes: %v", err)
	}
	return fmt.Sprintf("%s-%s", sanitize(t.Name()), hex.EncodeToString(buf))
}

// sanitize keeps a test's name in its ids — worth the few characters when
// reading a stuck row in DynamoDB — minus anything a key can't hold.
func sanitize(name string) string {
	out := make([]rune, 0, len(name))
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-':
			out = append(out, r)
		default:
			out = append(out, '-')
		}
	}
	return string(out)
}

// ciphertext is a stand-in for whatever a client would have encrypted.
// Random because the relay is blind: it never reads these bytes, and a
// test that pretended otherwise would be asserting something the design
// forbids.
func ciphertext(t *testing.T) string {
	t.Helper()
	buf := make([]byte, 64)
	if _, err := rand.Read(buf); err != nil {
		t.Fatalf("failed to read random bytes: %v", err)
	}
	return base64.StdEncoding.EncodeToString(buf)
}
