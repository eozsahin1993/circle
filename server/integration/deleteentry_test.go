package integration_test

import (
	"net/http"
	"testing"

	"mimoza-relay/integration/harness"
)

// deleteentry, end to end: the relay strips an entry's ciphertext and
// appends its tombstone in one authorized call. internal/synclog
// dynamodb's own tests already prove DeleteEntry's behavior in isolation;
// what's missing there is the session and routing layer these tests
// drive, the same gap blob_test.go fills for deleteblob.

func TestDeleteEntry_TheAuthorCanDeleteTheirOwnPost(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	post := c.NewAppend(harness.Content)
	c.AppendLog(post).Expect(http.StatusOK)

	c.DeleteEntry(post.EntryID, c.NewDeleteEntry(post.EntryID)).Expect(http.StatusOK)

	entries := c.Entries(harness.Content)
	if len(entries) != 2 {
		t.Fatalf("expected the post to survive alongside its tombstone, got %d entries", len(entries))
	}
	if entries[0].DeletedAt == 0 {
		t.Fatal("expected the post's DeletedAt to be set")
	}
	if entries[0].EncryptedMeta != "" {
		t.Fatalf("expected the post's EncryptedMeta to be gone, got %q", entries[0].EncryptedMeta)
	}
}

func TestDeleteEntry_AnotherMemberWithNoSignatureIsRefused(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	post := c.NewAppend(harness.Content)
	c.AppendLog(post).Expect(http.StatusOK)

	// A different account holding the same write token — a second device
	// in the same circle, same gap deleteblob closes for uploads.
	other := c.As(r.SignIn())
	other.DeleteEntry(post.EntryID, other.NewDeleteEntry(post.EntryID)).Expect(http.StatusForbidden)

	entries := c.Entries(harness.Content)
	if len(entries) != 1 || entries[0].DeletedAt != 0 {
		t.Fatal("expected the post to survive a refused delete")
	}
}

func TestDeleteEntry_AnAdminSignatureDeletesSomeoneElsesPost(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	post := c.NewAppend(harness.Content)
	c.AppendLog(post).Expect(http.StatusOK)

	other := c.As(r.SignIn())
	other.DeleteEntry(post.EntryID, other.NewAdminDeleteEntry(post.EntryID, c.Admin)).Expect(http.StatusOK)

	entries := c.Entries(harness.Content)
	if entries[0].DeletedAt == 0 {
		t.Fatal("expected the post's DeletedAt to be set")
	}
}

func TestDeleteEntry_UnknownTargetEntryIDIsRefused(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	c.DeleteEntry(harness.Suffix(), c.NewDeleteEntry(harness.Suffix())).Expect(http.StatusNotFound)
}

func TestDeleteEntry_MissingTombstoneEntryIDIsRejected(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	post := c.NewAppend(harness.Content)
	c.AppendLog(post).Expect(http.StatusOK)

	req := c.NewDeleteEntry(post.EntryID)
	req.TombstoneEntryID = ""
	c.DeleteEntry(post.EntryID, req).Expect(http.StatusBadRequest)
}
