package s3_test

import (
	"strings"
	"testing"

	"mimoza-relay/internal/util/testsupport"
)

// With its settings and key in SSM, the relay hands out a CloudFront URL
// rather than an S3 one — the handover Terraform writes and the relay
// reads, exercised end to end against LocalStack.
//
// CloudFront is Pro-only in LocalStack, so this proves the relay's half:
// finding the settings, parsing the key, signing the right URL. Whether
// CloudFront accepts that signature only shows up in staging.
func TestGetDownloadURL_SignsForTheCDNWhenSSMSaysSo(t *testing.T) {
	store := testsupport.NewBlobStoreWithCDN(t, testsupport.UniqueSyncID(t))
	syncID := testsupport.UniqueSyncID(t)

	url, err := store.GetDownloadURL(t.Context(), syncID, "entry-1")
	if err != nil {
		t.Fatalf("GetDownloadURL: %v", err)
	}

	if !strings.HasPrefix(url, "https://cdn.example.com/"+syncID+"/entry-1?") {
		t.Fatalf("expected a signed cdn url, got %s", url)
	}
	for _, param := range []string{"Expires=", "Signature=", "Key-Pair-Id=K123"} {
		if !strings.Contains(url, param) {
			t.Fatalf("signed url is missing %s: %s", param, url)
		}
	}
}

// Without those parameters nothing changes: downloads stay on presigned
// S3 URLs, which is how local runs and any pre-CDN environment work.
func TestGetDownloadURL_StaysOnS3WithoutSettings(t *testing.T) {
	store := testsupport.NewBlobStore(t)

	url, err := store.GetDownloadURL(t.Context(), testsupport.UniqueSyncID(t), "entry-1")
	if err != nil {
		t.Fatalf("GetDownloadURL: %v", err)
	}

	if strings.Contains(url, "cdn.example.com") {
		t.Fatalf("expected a presigned S3 url, got %s", url)
	}
}
