package s3_test

import (
	"bytes"
	"errors"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"testing"

	"mimoza-relay/internal/synclog"
	blobs3 "mimoza-relay/internal/synclog/s3"
	"mimoza-relay/internal/util/localstack"
	"mimoza-relay/internal/util/testsupport"
)

// GetUploadTarget refuses a second target once a blob has actually landed
// at that key — see its doc comment for why this matters (a shared write
// token can't distinguish the original author from any other current
// member). A retry before any upload has succeeded must still work, since
// nothing has been created yet to conflict with.
func TestGetUploadTarget_RefusesOnceABlobExists(t *testing.T) {
	store := testsupport.NewBlobStore(t)
	ctx := t.Context()
	syncID := testsupport.UniqueSyncID(t)

	retryTarget, err := store.GetUploadTarget(ctx, syncID, "entry-1", "circle-scoped-public-key-uploader")
	if err != nil {
		t.Fatalf("expected a retry before any upload has succeeded to still work: %v", err)
	}
	if status, body := postUpload(t, retryTarget, []byte("hello world")); status < 200 || status >= 300 {
		t.Fatalf("upload failed: %d %s", status, body)
	}

	if _, err := store.GetUploadTarget(ctx, syncID, "entry-1", "circle-scoped-public-key-uploader"); !errors.Is(err, synclog.ErrBlobAlreadyExists) {
		t.Fatalf("expected ErrBlobAlreadyExists once a blob has actually landed, got %v", err)
	}
}

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

	target, err := store.GetUploadTarget(ctx, testsupport.UniqueSyncID(t), "entry-1", "circle-scoped-public-key-uploader")
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

	target, err := store.GetUploadTarget(ctx, testsupport.UniqueSyncID(t), "entry-1", "circle-scoped-public-key-uploader")
	if err != nil {
		t.Fatalf("GetUploadTarget: %v", err)
	}

	const overDefaultMax = 2*1024*1024 + 1
	status, body := postUpload(t, target, make([]byte, overDefaultMax))
	if status >= 200 && status < 300 {
		t.Fatalf("expected the oversized upload to be rejected by S3's content-length-range condition, but it succeeded: %s", body)
	}
}

// A URL presigned for another address of the same LocalStack is signed
// for that host, so both the upload and the host-covering GET signature
// still work through it — what cmd/server relies on to hand devices a
// reachable address. Without the override, URLs keep the client's own
// endpoint: the path cmd/lambda always takes.
func TestPresignEndpoint_SignsForTheGivenHost(t *testing.T) {
	store := testsupport.NewBlobStore(t)
	syncID := testsupport.UniqueSyncID(t)

	endpoint, err := url.Parse(localstack.Endpoint())
	if err != nil {
		t.Fatalf("parse LocalStack endpoint: %v", err)
	}
	otherHost := "127.0.0.1"
	if endpoint.Hostname() == otherHost {
		otherHost = "localhost"
	}

	plain, err := store.GetDownloadURL(t.Context(), syncID, "entry-1")
	if err != nil {
		t.Fatalf("GetDownloadURL: %v", err)
	}
	if got := mustHost(t, plain); got != endpoint.Host {
		t.Fatalf("without an override the URL should keep the client's endpoint %s, got %s", endpoint.Host, got)
	}

	other := *endpoint
	other.Host = net.JoinHostPort(otherHost, endpoint.Port())
	ctx := blobs3.WithPresignEndpoint(t.Context(), other.String())

	target, err := store.GetUploadTarget(ctx, syncID, "entry-1", "circle-scoped-public-key-uploader")
	if err != nil {
		t.Fatalf("GetUploadTarget: %v", err)
	}
	if got := mustHost(t, target.URL); got != other.Host {
		t.Fatalf("upload URL host = %s, want %s", got, other.Host)
	}
	if status, body := postUpload(t, target, []byte("hello world")); status < 200 || status >= 300 {
		t.Fatalf("upload through %s failed: %d %s", other.Host, status, body)
	}

	download, err := store.GetDownloadURL(ctx, syncID, "entry-1")
	if err != nil {
		t.Fatalf("GetDownloadURL: %v", err)
	}
	if got := mustHost(t, download); got != other.Host {
		t.Fatalf("download URL host = %s, want %s", got, other.Host)
	}
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, download, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET download: %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read download: %v", err)
	}
	if resp.StatusCode != http.StatusOK || string(body) != "hello world" {
		t.Fatalf("download through %s = %d %q, want 200 \"hello world\"", other.Host, resp.StatusCode, body)
	}
}

func mustHost(t *testing.T, raw string) string {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %q: %v", raw, err)
	}
	return parsed.Host
}

// postUpload sends payload to a presigned POST target — fields must come
// before the "file" field, since S3 requires that order and ignores
// anything after it.
func postUpload(t *testing.T, target synclog.UploadTarget, payload []byte) (int, string) {
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

// DeleteCircle takes every object under the circle's prefix — post blobs
// and the cover photo alike — and leaves a neighbouring circle's alone.
// The neighbour's syncID deliberately extends the target's, which is what
// a prefix without its trailing slash would wrongly match.
func TestDeleteCircle_RemovesEveryBlobUnderThePrefixAndNothingElse(t *testing.T) {
	store := testsupport.NewBlobStore(t)
	ctx := t.Context()
	syncID := testsupport.UniqueSyncID(t)
	neighbour := syncID + "-extended"

	for _, blob := range []struct{ sync, entry string }{
		{syncID, "entry-1"},
		{syncID, "entry-2"},
		{neighbour, "entry-1"},
	} {
		target, err := store.GetUploadTarget(ctx, blob.sync, blob.entry, "circle-scoped-public-key-uploader")
		if err != nil {
			t.Fatal(err)
		}
		if status, body := postUpload(t, target, []byte("ciphertext")); status < 200 || status >= 300 {
			t.Fatalf("upload failed: %d %s", status, body)
		}
	}
	coverTarget, err := store.GetCoverPhotoUploadTarget(ctx, syncID)
	if err != nil {
		t.Fatal(err)
	}
	if status, body := postUpload(t, coverTarget, []byte("cover")); status < 200 || status >= 300 {
		t.Fatalf("cover upload failed: %d %s", status, body)
	}

	if err := store.DeleteCircle(ctx, syncID); err != nil {
		t.Fatalf("sweeping the circle's blobs failed: %v", err)
	}

	for _, entryID := range []string{"entry-1", "entry-2", "cover"} {
		if _, err := store.UploaderPublicKey(ctx, syncID, entryID); !errors.Is(err, synclog.ErrBlobNotFound) {
			t.Fatalf("expected %s swept, got %v", entryID, err)
		}
	}
	if _, err := store.UploaderPublicKey(ctx, neighbour, "entry-1"); err != nil {
		t.Fatalf("a circle whose syncID merely extends the deleted one must be untouched: %v", err)
	}
}

// Idempotent, so the caller can retry a sweep that died partway — and
// safe on a circle that never had a blob at all.
func TestDeleteCircle_IsIdempotent(t *testing.T) {
	store := testsupport.NewBlobStore(t)
	ctx := t.Context()
	syncID := testsupport.UniqueSyncID(t)

	if err := store.DeleteCircle(ctx, syncID); err != nil {
		t.Fatalf("sweeping a circle with no blobs must succeed: %v", err)
	}
	if err := store.DeleteCircle(ctx, syncID); err != nil {
		t.Fatalf("a second sweep must succeed: %v", err)
	}
}
