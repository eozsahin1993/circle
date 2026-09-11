package apns

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadsTheKeyAlongsideItsIDs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "key.p8")
	if err := os.WriteFile(path, []byte("key-bytes"), 0o600); err != nil {
		t.Fatal(err)
	}

	key, err := (&Loader{FilePath: path, KeyID: "kid", TeamID: "team"}).Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if key.KeyID != "kid" || key.TeamID != "team" || key.PrivateKey != "key-bytes" {
		t.Fatalf("key did not load: %+v", key)
	}
}

// The .p8 file carries no id of its own, unlike FCM's JSON blob — so a
// missing config value must be caught here rather than surfacing as a
// confusing signing failure later.
func TestMissingKeyIDOrTeamIDIsRejected(t *testing.T) {
	path := filepath.Join(t.TempDir(), "key.p8")
	if err := os.WriteFile(path, []byte("key-bytes"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := (&Loader{FilePath: path, TeamID: "team"}).Load(context.Background()); err == nil {
		t.Fatal("expected an error when the key id is missing")
	}
	if _, err := (&Loader{FilePath: path, KeyID: "kid"}).Load(context.Background()); err == nil {
		t.Fatal("expected an error when the team id is missing")
	}
}

func TestAMissingFileIsReported(t *testing.T) {
	_, err := (&Loader{FilePath: "/nowhere/key.p8", KeyID: "kid", TeamID: "team"}).Load(context.Background())
	if err == nil || !strings.Contains(err.Error(), "/nowhere/key.p8") {
		t.Fatalf("expected the path named, got %v", err)
	}
}
