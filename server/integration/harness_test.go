// Package integration_test drives the relay the way a client does: over HTTP,
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
package integration_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
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
	"circle-relay/internal/localstack"
	"circle-relay/internal/storage/authstore"
)

// sessionTTL only has to outlast one test.
const sessionTTL = time.Hour

// relay is a running relay and the means to talk to it. It carries the
// test, so nothing downstream has to be handed one again.
type relay struct {
	t       *testing.T
	baseURL string
	// sessions is how a caller gets a bearer token. Written directly
	// rather than through a test-only HTTP route: this suite holds the
	// store, and a route that mints sessions is something cmd/testrelay
	// needs only because the app can't reach into the relay's process.
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

	names := localstack.Unique(suffix())
	if err := localstack.ProvisionSet(ctx, ddb, s3Client, names); err != nil {
		unreachable(t, err)
	}
	t.Cleanup(func() { localstack.TeardownSet(context.Background(), ddb, s3Client, names) })

	deps := app.Deps(localstack.RelayConfig(names), awsCfg)

	baseURL := os.Getenv("RELAY_URL")
	if baseURL == "" {
		server := httptest.NewServer(api.NewRouter(deps))
		t.Cleanup(server.Close)
		baseURL = server.URL
	}

	return &relay{t: t, baseURL: baseURL, sessions: deps.Auth}
}

// unreachable skips, or fails when the environment says a missing
// LocalStack is a broken pipeline — see localstack.Required, which
// internal/testsupport consults for the same decision.
func unreachable(t *testing.T, err error) {
	t.Helper()
	if localstack.Required() {
		t.Fatalf("%s is set but the relay's storage is unreachable: %v", localstack.RequireEnv, err)
	}
	t.Skipf("LocalStack not reachable, skipping: %v", err)
}

// device is one caller of the relay. Named for what it is on the relay's
// side: an account with a session, holding no circle state of its own.
type device struct {
	relay     *relay
	accountID string
	token     string
}

// signIn mints a session for a fresh account, skipping Google and Apple.
// Provider verification is internal/api's business; what matters here is
// that requests carry a credential the relay accepts.
func (r *relay) signIn() *device {
	r.t.Helper()
	d := &device{relay: r, accountID: "test:" + suffix(), token: suffix()}
	session := authstore.Session{AccountID: d.accountID, ExpiresAt: time.Now().Add(sessionTTL)}
	if err := r.sessions.SaveSession(context.Background(), d.token, session); err != nil {
		r.t.Fatalf("failed to mint a session: %v", err)
	}
	return d
}

// anon is a caller with no session, for the routes that must refuse one.
func (r *relay) anon() *device {
	return &device{relay: r}
}

// body is a JSON object to send. A named type because almost every request
// here carries one field, and map[string]string at each call site buries
// what's actually being sent.
type body map[string]string

func (d *device) get(path string) response         { return d.send(http.MethodGet, path, nil) }
func (d *device) put(path string, b body) response { return d.send(http.MethodPut, path, b) }
func (d *device) delete(path string) response      { return d.send(http.MethodDelete, path, nil) }

func (d *device) send(method, path string, b body) response {
	t := d.relay.t
	t.Helper()

	var payload io.Reader
	if b != nil {
		encoded, err := json.Marshal(b)
		if err != nil {
			t.Fatalf("failed to encode the request body: %v", err)
		}
		payload = bytes.NewReader(encoded)
	}

	req, err := http.NewRequest(method, d.relay.baseURL+path, payload)
	if err != nil {
		t.Fatalf("failed to build the request: %v", err)
	}
	if b != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if d.token != "" {
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
	return response{t: t, method: method, path: path, status: res.StatusCode, body: read}
}

// response is one HTTP reply, kept whole so a test can assert on the
// status and the body without re-reading either. Go's stdlib has no
// assertion library, so expect and decode below are the whole of it.
type response struct {
	t      *testing.T
	method string
	path   string
	status int
	body   []byte
}

// expect fails unless the status matches, naming the request and quoting
// the body — which is where the relay says why, and the first thing
// anyone wants when a integration test goes red.
func (res response) expect(status int) response {
	res.t.Helper()
	if res.status != status {
		res.t.Fatalf("%s %s: got %d, want %d: %s", res.method, res.path, res.status, status, res.body)
	}
	return res
}

// decode reads the body into target.
func (res response) decode(target any) response {
	res.t.Helper()
	if err := json.Unmarshal(res.body, target); err != nil {
		res.t.Fatalf("%s %s: failed to decode %q: %v", res.method, res.path, res.body, err)
	}
	return res
}

// assertEqual fails unless got matches want, naming what was compared. Go
// has no assertion library in std, and `if got != want { t.Fatalf(...) }`
// at every call site buries the claim under the plumbing. Named to match
// JUnit's assertEqual/assertTrue rather than invent a new vocabulary.
func assertEqual[T comparable](t *testing.T, what string, got, want T) {
	t.Helper()
	if got != want {
		t.Fatalf("%s: got %v, want %v", what, got, want)
	}
}

// assertTrue fails when cond is false, saying what should have held. For
// the claims that aren't a comparison.
func assertTrue(t *testing.T, cond bool, format string, args ...any) {
	t.Helper()
	if !cond {
		t.Fatalf(format, args...)
	}
}

// suffix is an id nothing else will use — for an account, a token, an
// invite tag, or a set of table names. Resource-name safe: lowercase hex,
// short enough for S3's 63-character bucket limit.
func suffix() string {
	buf := make([]byte, 8)
	// crypto/rand.Read is documented never to return an error.
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

// ciphertext stands in for whatever a client would have encrypted. Random
// because the relay is blind: it never reads these bytes, and a test that
// pretended otherwise would be asserting something the design forbids.
func ciphertext() string {
	buf := make([]byte, 64)
	_, _ = rand.Read(buf)
	return base64.StdEncoding.EncodeToString(buf)
}
