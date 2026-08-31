package getblob_test

import (
	"context"
	"strings"
	"testing"

	"circle-relay/internal/api/getblob"
	"circle-relay/internal/testsupport"
)

func TestService_DownloadURL_DerivedFromCircleLogIDAndEpoch(t *testing.T) {
	ctx := context.Background()
	service := &getblob.Service{BlobStore: testsupport.NewBlobStore(t)}

	url, err := service.DownloadURL(ctx, "circle-a", 7)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(url, "circle-a/7") {
		t.Fatalf("expected URL to reference circle-a/7, got %q", url)
	}
}
