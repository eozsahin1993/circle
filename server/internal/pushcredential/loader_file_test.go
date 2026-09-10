package pushcredential

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Local runs read the key from disk, since LocalStack has no parameter.
func TestLoadsFromAFileWhenGiven(t *testing.T) {
	path := filepath.Join(t.TempDir(), "key.json")
	if err := os.WriteFile(path, []byte(validKey), 0o600); err != nil {
		t.Fatal(err)
	}

	// No SSM client at all: a file path must not need one.
	account, err := (&Loader{FilePath: path}).Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if account.ProjectID != "circle-3ee1d" {
		t.Fatalf("key did not load: %+v", account)
	}
}

func TestAMissingFileIsReported(t *testing.T) {
	_, err := (&Loader{FilePath: "/nowhere/key.json"}).Load(context.Background())
	if err == nil || !strings.Contains(err.Error(), "/nowhere/key.json") {
		t.Fatalf("expected the path named, got %v", err)
	}
}

// The error names the file rather than the parameter it never read.
func TestAMalformedFileNamesTheFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "key.json")
	if err := os.WriteFile(path, []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := (&Loader{FilePath: path, ParameterName: "/circle/fcm-service-account"}).Load(context.Background())
	if err == nil || strings.Contains(err.Error(), "/circle/fcm-service-account") {
		t.Fatalf("expected the file named, got %v", err)
	}
}
