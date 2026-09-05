package dynamodb_test

import (
	"context"
	"testing"
	"time"

	"circle-relay/internal/testsupport"
)

func TestRateLimitStore_Allow_AllowsTheFirstRequestForANewKey(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewRateLimitStore(t, "write", 3, time.Minute)

	allowed, err := store.Allow(ctx, testsupport.UniqueAccountID(t))
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Fatal("expected the first request for a never-seen key to be allowed")
	}
}

func TestRateLimitStore_Allow_AllowsUpToTheLimitThenRejects(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewRateLimitStore(t, "write", 3, time.Minute)
	key := testsupport.UniqueAccountID(t)

	for i := 0; i < 3; i++ {
		allowed, err := store.Allow(ctx, key)
		if err != nil {
			t.Fatal(err)
		}
		if !allowed {
			t.Fatalf("expected request %d (within the limit of 3) to be allowed", i+1)
		}
	}

	allowed, err := store.Allow(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("expected the 4th request within the same window to be rejected")
	}
}

func TestRateLimitStore_Allow_ResetsOnceTheWindowExpires(t *testing.T) {
	ctx := context.Background()
	// A near-zero window means "expired" the moment any time at all has
	// passed, without a real test sleep.
	store := testsupport.NewRateLimitStore(t, "write", 1, time.Nanosecond)
	key := testsupport.UniqueAccountID(t)

	first, err := store.Allow(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	if !first {
		t.Fatal("expected the first request to be allowed")
	}

	time.Sleep(time.Millisecond)

	second, err := store.Allow(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	if !second {
		t.Fatal("expected a request in a new window (after the previous one expired) to be allowed")
	}
}

func TestRateLimitStore_Allow_DoesNotShareACounterAcrossKeyPrefixes(t *testing.T) {
	ctx := context.Background()
	sharedKey := testsupport.UniqueAccountID(t)
	writeStore := testsupport.NewRateLimitStore(t, "write", 1, time.Minute)
	readStore := testsupport.NewRateLimitStore(t, "read", 1, time.Minute)

	if allowed, err := writeStore.Allow(ctx, sharedKey); err != nil || !allowed {
		t.Fatalf("expected the write store's first request to be allowed, got allowed=%v err=%v", allowed, err)
	}
	if allowed, err := writeStore.Allow(ctx, sharedKey); err != nil || allowed {
		t.Fatalf("expected the write store's second request (over its limit of 1) to be rejected, got allowed=%v err=%v", allowed, err)
	}

	// Same underlying accountID, but a different budget (read) — must not
	// have been exhausted by the write store's calls above.
	if allowed, err := readStore.Allow(ctx, sharedKey); err != nil || !allowed {
		t.Fatalf("expected the read store's first request for the same account to be allowed, got allowed=%v err=%v", allowed, err)
	}
}
