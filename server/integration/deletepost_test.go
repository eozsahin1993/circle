package integration_test

import (
	"net/http"
	"testing"

	"circle-relay/integration/harness"
)

// deletepost, end to end: the relay strips a post's ciphertext and
// appends its tombstone in one authorized call. internal/storage/logstore
// dynamodb's own tests already prove DeletePost's behavior in isolation;
// what's missing there is the session and routing layer these tests
// drive, the same gap blob_test.go fills for deleteblob.

func TestDeletePost_TheAuthorCanDeleteTheirOwnPost(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	post := c.NewAppend(harness.Content)
	c.AppendLog(post).Expect(http.StatusOK)

	c.DeletePost(post.EntryID, c.NewDeletePost(post.EntryID)).Expect(http.StatusOK)

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

func TestDeletePost_AnotherMemberWithNoSignatureIsRefused(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	post := c.NewAppend(harness.Content)
	c.AppendLog(post).Expect(http.StatusOK)

	// A different account holding the same write token — a second device
	// in the same circle, same gap deleteblob closes for uploads.
	other := c.As(r.SignIn())
	other.DeletePost(post.EntryID, other.NewDeletePost(post.EntryID)).Expect(http.StatusForbidden)

	entries := c.Entries(harness.Content)
	if len(entries) != 1 || entries[0].DeletedAt != 0 {
		t.Fatal("expected the post to survive a refused delete")
	}
}

func TestDeletePost_AnAdminSignatureDeletesSomeoneElsesPost(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	post := c.NewAppend(harness.Content)
	c.AppendLog(post).Expect(http.StatusOK)

	other := c.As(r.SignIn())
	other.DeletePost(post.EntryID, other.NewAdminDeletePost(post.EntryID, c.Admin)).Expect(http.StatusOK)

	entries := c.Entries(harness.Content)
	if entries[0].DeletedAt == 0 {
		t.Fatal("expected the post's DeletedAt to be set")
	}
}

func TestDeletePost_UnknownPostEntryIDIsRefused(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	c.DeletePost(harness.Suffix(), c.NewDeletePost(harness.Suffix())).Expect(http.StatusNotFound)
}

func TestDeletePost_MissingTombstoneEntryIDIsRejected(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	post := c.NewAppend(harness.Content)
	c.AppendLog(post).Expect(http.StatusOK)

	req := c.NewDeletePost(post.EntryID)
	req.TombstoneEntryID = ""
	c.DeletePost(post.EntryID, req).Expect(http.StatusBadRequest)
}
