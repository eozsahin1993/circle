package synclog

import "testing"

// Pins the literal bytes signed-messages.test.ts must match — paired
// manually, since a drift here fails silently until the two sides talk.
func TestMessages_MatchTheClientsByteConstruction(t *testing.T) {
	cases := []struct {
		name string
		got  []byte
		want string
	}{
		{
			"RotateMessage",
			RotateMessage("sync-1", "entry-1", "hash-1"),
			"circle-relay/rotate/v1\x00sync-1\x00entry-1\x00hash-1",
		},
		{
			"AuthorityChange.Message add",
			AuthorityChange{Action: AuthorityAdd, SyncID: "sync-1", EntryID: "entry-1", TargetAuthorityPublicKey: "key-1"}.Message(),
			"circle-relay/authority-change/v1\x00add\x00sync-1\x00entry-1\x00key-1",
		},
		{
			"AuthorityChange.Message remove",
			AuthorityChange{Action: AuthorityRemove, SyncID: "sync-1", EntryID: "entry-1", TargetAuthorityPublicKey: "key-1"}.Message(),
			"circle-relay/authority-change/v1\x00remove\x00sync-1\x00entry-1\x00key-1",
		},
		{
			"CoverPhotoUploadMessage",
			CoverPhotoUploadMessage("sync-1"),
			"circle-relay/cover-photo-upload/v1\x00sync-1",
		},
		{
			"DeleteBlobMessage",
			DeleteBlobMessage("sync-1", "entry-1"),
			"circle-relay/delete-blob/v1\x00sync-1\x00entry-1",
		},
		{
			"CircleDeletion.Message",
			CircleDeletion{SyncID: "sync-1", EntryID: "entry-1"}.Message(),
			"circle-relay/delete-circle/v1\x00sync-1\x00entry-1",
		},
		{
			"EntryDeletion.Message",
			EntryDeletion{SyncID: "sync-1", TargetEntryID: "entry-1", TombstoneEntryID: "tomb-1"}.Message(),
			"circle-relay/delete-entry/v1\x00sync-1\x00entry-1\x00tomb-1",
		},
		{
			"AuthorContentDeletion.Message",
			AuthorContentDeletion{SyncID: "sync-1", AuthorIdentityPublicKey: "author-1", TombstoneEntryID: "tomb-1"}.Message(),
			"circle-relay/delete-author-content/v1\x00sync-1\x00author-1\x00tomb-1",
		},
		{
			"AuthorContentDeletion.Message strip-only",
			AuthorContentDeletion{SyncID: "sync-1", AuthorIdentityPublicKey: "author-1", TombstoneEntryID: ""}.Message(),
			"circle-relay/delete-author-content/v1\x00sync-1\x00author-1\x00",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if string(c.got) != c.want {
				t.Fatalf("got %q, want %q", c.got, c.want)
			}
		})
	}
}
