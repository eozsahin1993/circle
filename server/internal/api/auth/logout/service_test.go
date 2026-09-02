package logout_test

import (
	"context"
	"testing"
	"time"

	"circle-relay/internal/api/auth/logout"
	"circle-relay/internal/storage/authstore"
	"circle-relay/internal/testsupport"
)

func TestService_Logout_RevokesTheSession(t *testing.T) {
	ctx := context.Background()
	authStore := testsupport.NewAuthStore(t)
	svc := &logout.Service{AuthStore: authStore}

	token := testsupport.UniqueAccountID(t)
	if err := authStore.SaveSession(ctx, token, authstore.Session{
		AccountID: testsupport.UniqueAccountID(t),
		ExpiresAt: time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}

	if err := svc.Logout(ctx, token); err != nil {
		t.Fatal(err)
	}

	session, err := authStore.GetSession(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	if session != nil {
		t.Fatalf("expected the session to be gone after Logout, got %+v", session)
	}
}

func TestService_Logout_IsIdempotentForAnUnknownToken(t *testing.T) {
	ctx := context.Background()
	svc := &logout.Service{AuthStore: testsupport.NewAuthStore(t)}

	if err := svc.Logout(ctx, testsupport.UniqueAccountID(t)); err != nil {
		t.Fatalf("expected logging out a never-existed session to succeed, got %v", err)
	}
}
