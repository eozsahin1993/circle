package integration_test

import (
	"net/http"
	"testing"

	"mimoza-relay/integration/harness"
)

// deleteauthorcontent, end to end: the relay strips every content entry
// one identity authored, in both modes. The dynamodb store tests already
// prove the strip's behavior in isolation; these drive the session and
// routing layer, same gap deleteentry_test.go fills for single deletes.

func TestDeleteAuthorContent_AMemberErasesEverythingTheyWroteAndAnnouncesIt(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	mine := c.NewAppend(harness.Content)
	c.AppendLog(mine).Expect(http.StatusOK)

	other := c.As(r.SignIn())
	theirs := other.NewAppend(harness.Content)
	other.AppendLog(theirs).Expect(http.StatusOK)

	c.DeleteAuthorContent(c.NewDeleteAuthorContent()).Expect(http.StatusOK)

	entries := c.Entries(harness.Content)
	if len(entries) != 2 {
		t.Fatalf("expected both content rows to survive, tombstone excluded, got %d entries", len(entries))
	}
	if entries[0].DeletedAt == 0 || entries[0].EncryptedMeta != "" {
		t.Fatal("expected the author's entry stripped and stamped")
	}
	if entries[1].DeletedAt != 0 || entries[1].EncryptedMeta == "" {
		t.Fatal("expected the other member's entry untouched")
	}

	// The tombstone is meta, not content — it also announces the roster
	// removal every client's account-deletion path folds into it.
	meta := c.Entries(harness.Meta)
	if len(meta) != 1 || meta[0].DeletedAt != 0 || meta[0].EncryptedMeta == "" {
		t.Fatalf("expected exactly the tombstone in meta, got %+v", meta)
	}
}

func TestDeleteAuthorContent_StripOnlyModeNeedsNoWriteToken(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	c.AppendLog(c.NewAppend(harness.Content)).Expect(http.StatusOK)

	c.DeleteAuthorContent(c.NewStripOnlyAuthorContent()).Expect(http.StatusOK)

	entries := c.Entries(harness.Content)
	if len(entries) != 1 {
		t.Fatalf("expected no tombstone in strip-only mode, got %d entries", len(entries))
	}
	if entries[0].DeletedAt == 0 || entries[0].EncryptedMeta != "" {
		t.Fatal("expected the entry stripped and stamped")
	}
}

func TestDeleteAuthorContent_AForgedSignatureIsRefused(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	c.AppendLog(c.NewAppend(harness.Content)).Expect(http.StatusOK)

	// Another member claims this author's key but signs with their own.
	impostor := c.As(r.SignIn())
	req := impostor.NewStripOnlyAuthorContent()
	req.AuthorIdentityPublicKey = c.NewStripOnlyAuthorContent().AuthorIdentityPublicKey
	impostor.DeleteAuthorContent(req).Expect(http.StatusForbidden)

	entries := c.Entries(harness.Content)
	if entries[0].DeletedAt != 0 {
		t.Fatal("expected the entry to survive a refused erase")
	}
}

func TestDeleteAuthorContent_AnUnknownCircleIs404(t *testing.T) {
	r := harness.Start(t)
	ghost := harness.UnknownCircle(t, r)

	ghost.DeleteAuthorContent(ghost.NewStripOnlyAuthorContent()).Expect(http.StatusNotFound)
}

func TestDeleteAuthorContent_TombstoneFieldsWithoutTombstoneIDAreRejected(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	req := c.NewStripOnlyAuthorContent()
	req.WriteToken = c.Token.Raw
	c.DeleteAuthorContent(req).Expect(http.StatusBadRequest)
}
