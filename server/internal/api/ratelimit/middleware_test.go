package ratelimit_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"circle-relay/internal/api/auth"
	"circle-relay/internal/api/ratelimit"
	"circle-relay/internal/storage/authstore"
	"circle-relay/internal/testsupport"
)

// fakeStore is a canned ratelimitstore.Store — the real dynamodb adapter's
// own CAS behavior is covered by ratelimitstore/dynamodb's own tests; this
// test only cares how the middleware reacts to Allow's outcome.
type fakeStore struct {
	allowed bool
	err     error
}

func (f fakeStore) Allow(context.Context, string) (bool, error) {
	return f.allowed, f.err
}

// newAuthenticatedRequest builds a request carrying a real, valid bearer
// token, plus a RequireSession wrapper primed to accept it —
// auth.AccountID(ctx) only gets populated by that real middleware, since
// its context key is unexported outside the auth package.
func newAuthenticatedRequest(t *testing.T) (*http.Request, func(http.Handler) http.Handler) {
	t.Helper()
	authStore := testsupport.NewAuthStore(t)
	token := testsupport.UniqueAccountID(t)
	if err := authStore.SaveSession(context.Background(), token, authstore.Session{
		AccountID: testsupport.UniqueAccountID(t),
		ExpiresAt: time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/circles/test/entries", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	return req, func(next http.Handler) http.Handler { return auth.RequireSession(authStore, next) }
}

func TestRequire_AllowsWhenUnderBudget(t *testing.T) {
	req, withSession := newAuthenticatedRequest(t)

	nextCalled := false
	handler := withSession(ratelimit.Require(fakeStore{allowed: true}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusOK)
	})))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !nextCalled {
		t.Fatal("expected next to be called when under budget")
	}
}

func TestRequire_RejectsWithTooManyRequestsWhenOverBudget(t *testing.T) {
	req, withSession := newAuthenticatedRequest(t)

	handler := withSession(ratelimit.Require(fakeStore{allowed: false}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("next should never be called when over budget")
	})))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d", rec.Code)
	}
}

func TestRequire_FailsOpenWhenTheStoreErrors(t *testing.T) {
	req, withSession := newAuthenticatedRequest(t)

	nextCalled := false
	handler := withSession(ratelimit.Require(fakeStore{err: errors.New("dynamodb unavailable")}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusOK)
	})))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected the request to be allowed through despite the store error, got %d", rec.Code)
	}
	if !nextCalled {
		t.Fatal("expected next to be called (fail open) when the store errors")
	}
}
