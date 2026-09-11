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
// The relay is blind (SYNC_DESIGN invariant 3), so an entry body can be
// any bytes at all — no client crypto to reproduce here, and nothing to
// drift out of step with the app.
//
// Each test gets its own relay over its own tables, torn down afterwards.
// The Go suite isolates by unique ids instead, which is sound and free,
// but it forces every assertion to filter to the caller's own rows — and
// "the list holds exactly one request" is a stronger claim than "the list
// holds mine". A private set costs about 200ms, which buys that.
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

// start builds a relay of this test's own, on tables nobody else holds,
// and registers their removal.
//
// httptest.NewServer, not the mux directly: that gives a real listener on
// a real port, so these requests cross an actual socket and go through
// net/http's own parsing rather than being handed to a handler. Set
// RELAY_URL to aim the same tests at a running cmd/testrelay, or at a
// deployed stack — in which case the tables are whatever that relay was
// started with, and isolation is its business rather than this one's.
func start(t *testing.T) *relay {
	t.Helper()
	ctx := context.Background()

	awsCfg, err := localstack.Config(ctx)
	if err != nil {
		unreachable(t, err)
	}

	ddb := awsdynamodb.NewFromConfig(awsCfg)
	s3Client := awss3.NewFromConfig(awsCfg, func(o *awss3.Options) { o.UsePathStyle = true })

	names := localstack.Unique(suffix(t))
	if err := localstack.ProvisionSet(ctx, ddb, s3Client, names); err != nil {
		unreachable(t, err)
	}
	t.Cleanup(func() { localstack.TeardownSet(context.Background(), ddb, s3Client, names) })

	deps := app.Deps(relayConfig(names), awsCfg)

	baseURL := os.Getenv("RELAY_URL")
	if baseURL == "" {
		server := httptest.NewServer(api.NewRouter(deps))
		t.Cleanup(server.Close)
		baseURL = server.URL
	}

	return &relay{baseURL: baseURL, sessions: deps.Auth}
}

// relayConfig mirrors config.Load's shape without the environment. Rate
// limits stay at their production defaults, unlike testsupport's million,
// so this is the one place the real budgets and the router run together.
func relayConfig(names localstack.Names) config.Config {
	return config.Config{
		TableName:                 names.LogTable,
		BucketName:                names.BlobBucket,
		SessionsTableName:         names.SessionsTable,
		AccountsTableName:         names.AccountsTable,
		InviteTableName:           names.InviteTable,
		RateLimitTableName:        names.RateLimitTable,
		PushTableName:             names.PushTable,
		RateLimitWriteMaxRequests: 500,
		RateLimitReadMaxRequests:  2000,
		RateLimitPushMaxRequests:  500,
		RateLimitWindowMinutes:    10,
		S3ForcePathStyle:          true,
	}
}

// unreachable decides what a missing LocalStack means.
//
// Skipping is right locally — not everyone has it running, and a red
// suite for that is noise. It is wrong in CI: a container that failed to
// start would skip every test here and the run would pass, reporting that
// nothing is broken because nothing was checked. So CI sets
// BLACKBOX_REQUIRE_RELAY and gets a failure instead.
func unreachable(t *testing.T, err error) {
	t.Helper()
	if os.Getenv("BLACKBOX_REQUIRE_RELAY") != "" {
		t.Fatalf("BLACKBOX_REQUIRE_RELAY is set but the relay's storage is unreachable: %v", err)
	}
	t.Skipf("LocalStack not reachable, skipping: %v", err)
}

// suffix is a resource-name-safe id for one test: lowercase, no
// underscores, short enough for S3's 63-character bucket limit.
func suffix(t *testing.T) string {
	t.Helper()
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		t.Fatalf("failed to read random bytes: %v", err)
	}
	return hex.EncodeToString(buf)
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
