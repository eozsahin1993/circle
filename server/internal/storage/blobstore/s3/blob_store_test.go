package s3_test

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"testing"

	"circle-relay/internal/storage/blobstore"
	"circle-relay/internal/testsupport"
)

// Exercises the actual presigned-POST-then-upload round trip against
// LocalStack, including S3's own enforcement of the content-length-range
// condition — nothing else in this codebase does either. Written while
// diagnosing an AccessDenied a mobile client was hitting: this same test,
// run against LocalStack 3.8 (~2 years old), failed identically even with
// a byte-for-byte correct multipart request — a real bug in that version's
// S3 provider, not a client bug or a flaw in this approach. It passes
// cleanly against LocalStack 4.4.0 (the last version usable without an
// auth token), which is why local dev is pinned there rather than to 3.8
// or the auth-gated current release.
func TestGetUploadTarget_RoundTrip(t *testing.T) {
	store := testsupport.NewBlobStore(t)
	ctx := t.Context()

	target, err := store.GetUploadTarget(ctx, testsupport.UniqueCircleID(t), 1)
	if err != nil {
		t.Fatalf("GetUploadTarget: %v", err)
	}

	status, body := postUpload(t, target, []byte("hello world"))
	if status < 200 || status >= 300 {
		t.Fatalf("upload failed: %d %s", status, body)
	}
}

func TestGetUploadTarget_RejectsOversizedBlob(t *testing.T) {
	store := testsupport.NewBlobStore(t)
	ctx := t.Context()

	target, err := store.GetUploadTarget(ctx, testsupport.UniqueCircleID(t), 1)
	if err != nil {
		t.Fatalf("GetUploadTarget: %v", err)
	}

	const overDefaultMax = 2*1024*1024 + 1
	status, body := postUpload(t, target, make([]byte, overDefaultMax))
	if status >= 200 && status < 300 {
		t.Fatalf("expected the oversized upload to be rejected by S3's content-length-range condition, but it succeeded: %s", body)
	}
}

// postUpload sends payload to a presigned POST target — fields must come
// before the "file" field, since S3 requires that order and ignores
// anything after it.
func postUpload(t *testing.T, target blobstore.UploadTarget, payload []byte) (int, string) {
	t.Helper()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range target.Fields {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatalf("WriteField(%s): %v", key, err)
		}
	}
	part, err := writer.CreateFormFile("file", "blob")
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := part.Write(payload); err != nil {
		t.Fatalf("write file part: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, target.URL, &body)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST upload: %v", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(respBody)
}
