// Package integration_test drives the relay the way a client does: over
// HTTP, with no access to anything inside it. Not for handler coverage —
// internal/api's own tests already have that — but for the sequences
// between calls, where a client's real problems live: create an invite,
// request against it, approve, then find the approval readable when it
// shouldn't be.
//
// The relay is blind (SYNC_DESIGN invariant 3), so an entry body is any
// bytes at all — no client crypto to reproduce, nothing to drift out of
// step with the app. Each test gets its own relay over its own tables
// (see localstack.Unique), so an assertion can claim a list holds exactly
// one row rather than merely holding its own.
package integration_test

import (
	"bytes"
	"context"
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

// start builds a relay of this test's own and registers its teardown.
// httptest.NewServer, not the mux directly, so requests cross a real
// socket. Set RELAY_URL to aim at a running cmd/testrelay or a deployed
// stack instead — its tables, its isolation.
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
// status and the body without re-reading either — see assertEqual and
// assertTrue in assert_test.go for comparisons that aren't about a
// response specifically.
type response struct {
	t      *testing.T
	method string
	path   string
	status int
	body   []byte
}

// expect fails unless the status matches, naming the request and quoting
// the body — where the relay says why, and the first thing anyone wants
// when this goes red.
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
