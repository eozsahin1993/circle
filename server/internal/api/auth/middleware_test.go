package auth_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"circle-relay/internal/api/auth"
	"circle-relay/internal/storage/authstore"
	"circle-relay/internal/testsupport"
)

func newTestRequest(token string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/circles/test/entries", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return req
}

func TestRequireSession_MissingTokenReturns401(t *testing.T) {
	handler := auth.RequireSession(testsupport.NewAuthStore(t), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("next should never be called without a token")
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, newTestRequest(""))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestRequireSession_UnknownTokenReturns401(t *testing.T) {
	handler := auth.RequireSession(testsupport.NewAuthStore(t), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("next should never be called for an unknown token")
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, newTestRequest(testsupport.UniqueEmailHMAC(t)))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestRequireSession_ExpiredSessionReturns401(t *testing.T) {
	ctx := context.Background()
	authStore := testsupport.NewAuthStore(t)
	token := testsupport.UniqueEmailHMAC(t)
	if err := authStore.SaveSession(ctx, token, authstore.Session{
		DeviceID:  testsupport.UniqueEmailHMAC(t),
		ExpiresAt: time.Now().Add(-time.Hour),
	}); err != nil {
		t.Fatal(err)
	}

	handler := auth.RequireSession(authStore, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("next should never be called for an expired session")
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, newTestRequest(token))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestRequireSession_ValidSessionCallsNextWithDeviceID(t *testing.T) {
	ctx := context.Background()
	authStore := testsupport.NewAuthStore(t)
	token := testsupport.UniqueEmailHMAC(t)
	deviceID := testsupport.UniqueEmailHMAC(t)
	if err := authStore.SaveSession(ctx, token, authstore.Session{
		DeviceID:  deviceID,
		ExpiresAt: time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}

	var gotDeviceID string
	handler := auth.RequireSession(authStore, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotDeviceID = auth.DeviceID(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, newTestRequest(token))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if gotDeviceID != deviceID {
		t.Fatalf("expected DeviceID(ctx) to be %q, got %q", deviceID, gotDeviceID)
	}
}
