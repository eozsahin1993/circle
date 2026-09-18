package s3

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// A client that is never called: these tests exercise the CDN path, which
// never reaches S3.
func unusedS3() *s3.Client { return s3.New(s3.Options{Region: "us-east-1"}) }

type fakeCDN struct {
	signed       []string
	invalidated  []string
	signErr      error
	invalidErr   error
	unconfigured bool
}

func (f *fakeCDN) Configured(context.Context) bool { return !f.unconfigured }

func (f *fakeCDN) SignedURL(_ context.Context, key string, _ time.Duration) (string, error) {
	if f.signErr != nil {
		return "", f.signErr
	}
	f.signed = append(f.signed, key)
	return "https://cdn.example.com/" + key + "?Signature=x", nil
}

func (f *fakeCDN) Invalidate(_ context.Context, paths ...string) error {
	f.invalidated = append(f.invalidated, paths...)
	return f.invalidErr
}

// The whole point of the CDN: the URL the client gets is CloudFront's,
// not S3's, so members share one cached object.
func TestGetDownloadURLUsesTheCDNWhenConfigured(t *testing.T) {
	cdn := &fakeCDN{}
	store := New(unusedS3(), "bucket", 0).WithDownloads(cdn)

	url, err := store.GetDownloadURL(t.Context(), "sync-1", "entry-1")
	if err != nil {
		t.Fatalf("GetDownloadURL: %v", err)
	}

	if !strings.HasPrefix(url, "https://cdn.example.com/sync-1/entry-1") {
		t.Fatalf("expected a CDN url, got %s", url)
	}
	if len(cdn.signed) != 1 || cdn.signed[0] != "sync-1/entry-1" {
		t.Fatalf("signed %v, want [sync-1/entry-1]", cdn.signed)
	}
}

// A circle's sweep invalidates one wildcard rather than a path per blob:
// a wildcard counts as a single path however many objects it matches.
func TestDeleteManyInvalidatesOneWildcard(t *testing.T) {
	cdn := &fakeCDN{}
	store := New(unusedS3(), "bucket", 0).WithDownloads(cdn)

	if err := store.invalidate(t.Context(), "sync-1/*"); err != nil {
		t.Fatalf("invalidate: %v", err)
	}

	if len(cdn.invalidated) != 1 || cdn.invalidated[0] != "sync-1/*" {
		t.Fatalf("invalidated %v, want [sync-1/*]", cdn.invalidated)
	}
}

// The bytes are already destroyed by the time this runs, so a failed
// invalidation must not report the delete as failed — it only means a
// cached copy outlives them until its TTL.
func TestInvalidationFailureDoesNotFailTheDelete(t *testing.T) {
	cdn := &fakeCDN{invalidErr: context.DeadlineExceeded}
	store := New(unusedS3(), "bucket", 0).WithDownloads(cdn)

	if err := store.invalidate(t.Context(), "sync-1/entry-1"); err != nil {
		t.Fatalf("invalidate should swallow the error, got %v", err)
	}
}

// Without a CDN configured nothing is invalidated and downloads stay on
// presigned S3 URLs — the local/LocalStack path.
func TestNoCDNMeansNoInvalidation(t *testing.T) {
	store := New(unusedS3(), "bucket", 0).WithDownloads(&fakeCDN{unconfigured: true})

	if err := store.invalidate(t.Context(), "sync-1/*"); err != nil {
		t.Fatalf("invalidate: %v", err)
	}
}
