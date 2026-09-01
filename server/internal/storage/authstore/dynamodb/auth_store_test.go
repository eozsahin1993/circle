package dynamodb_test

import (
	"context"
	"testing"
	"time"

	"circle-relay/internal/storage/authstore"
	"circle-relay/internal/testsupport"
)

func TestAuthStore_SaveSessionThenGetSession_RoundTrips(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewAuthStore(t)
	token := testsupport.UniqueEmailHMAC(t) // any unique opaque string works as a token here
	emailHmac := testsupport.UniqueEmailHMAC(t)
	expiresAt := time.Now().Add(time.Hour).Truncate(time.Second)

	if err := store.SaveSession(ctx, token, authstore.Session{DeviceID: emailHmac, ExpiresAt: expiresAt}); err != nil {
		t.Fatal(err)
	}

	session, err := store.GetSession(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	if session == nil || session.DeviceID != emailHmac {
		t.Fatalf("expected a session with DeviceID %q, got %+v", emailHmac, session)
	}
	if !session.ExpiresAt.Equal(expiresAt) {
		t.Fatalf("expected ExpiresAt %v, got %v", expiresAt, session.ExpiresAt)
	}
}

func TestAuthStore_GetSession_ReturnsNilForAnUnknownToken(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewAuthStore(t)

	session, err := store.GetSession(ctx, testsupport.UniqueEmailHMAC(t))
	if err != nil {
		t.Fatal(err)
	}
	if session != nil {
		t.Fatalf("expected nil for an unknown token, got %+v", session)
	}
}

func TestAuthStore_DeleteSession_RevokesAnExistingSession(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewAuthStore(t)
	token := testsupport.UniqueEmailHMAC(t)

	if err := store.SaveSession(ctx, token, authstore.Session{
		DeviceID:  testsupport.UniqueEmailHMAC(t),
		ExpiresAt: time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}

	if err := store.DeleteSession(ctx, token); err != nil {
		t.Fatal(err)
	}

	session, err := store.GetSession(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	if session != nil {
		t.Fatalf("expected the session to be gone after DeleteSession, got %+v", session)
	}
}

func TestAuthStore_DeleteSession_IsIdempotentForAnUnknownToken(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewAuthStore(t)

	if err := store.DeleteSession(ctx, testsupport.UniqueEmailHMAC(t)); err != nil {
		t.Fatalf("expected deleting a never-existed session to succeed, got %v", err)
	}
}
