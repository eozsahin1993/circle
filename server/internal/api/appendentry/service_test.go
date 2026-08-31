package appendentry_test

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"circle-relay/internal/api/appendentry"
	"circle-relay/internal/testsupport"
)

func TestService_Append_ReturnsUploadURLDerivedFromEpoch(t *testing.T) {
	ctx := context.Background()
	circleLogID := testsupport.UniqueCircleID(t)
	service := &appendentry.Service{
		LogStore:  testsupport.NewLogStore(t, 0),
		BlobStore: testsupport.NewBlobStore(t),
	}

	result, err := service.Append(ctx, circleLogID, "post-1", []byte("ciphertext"))
	if err != nil {
		t.Fatal(err)
	}

	wantSuffix := circleLogID + "/" + strconv.FormatInt(result.Epoch, 10)
	if !strings.Contains(result.UploadURL, wantSuffix) {
		t.Fatalf("expected upload URL to reference %s, got %q", wantSuffix, result.UploadURL)
	}
}

func TestService_Append_RetryingSameEntryIDConverges(t *testing.T) {
	ctx := context.Background()
	circleLogID := testsupport.UniqueCircleID(t)
	service := &appendentry.Service{
		LogStore:  testsupport.NewLogStore(t, 0),
		BlobStore: testsupport.NewBlobStore(t),
	}

	first, err := service.Append(ctx, circleLogID, "post-1", []byte("ciphertext"))
	if err != nil {
		t.Fatal(err)
	}
	retry, err := service.Append(ctx, circleLogID, "post-1", []byte("ciphertext"))
	if err != nil {
		t.Fatal(err)
	}

	if retry.Epoch != first.Epoch || retry.ReceivedAt != first.ReceivedAt {
		t.Fatalf("expected retry to return original result %+v, got %+v", first, retry)
	}
}
