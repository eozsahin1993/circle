package integration_test

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"testing"

	"circle-relay/integration/harness"
)

// getuploadtarget, getblob, deleteblob and getcoverphotouploadtarget, end
// to end against a real S3 (LocalStack): a presigned upload target
// obtained through the relay, used the way a client actually uses it (a
// plain POST straight to S3, never proxied through the relay — bytes stay
// off the relay's own compute and bandwidth, and the presigned URL is
// still gated behind the same write-token check that mints it), then read
// back through the relay's own redirect and deleted through it.
// internal/storage/blobstore/s3's own tests already prove the store's
// behaviour in isolation; what's missing there is the session,
// write-token and authority-signature gates in front of it, which only
// exist in the API layer these tests drive.
//
// The endpoints are harness.Circle's methods — see harness/circle.go.
// Every call here names which device is acting (harness.Circle.As), since
// who's calling is the point of half these tests.

// uploadBytes performs the actual upload against the presigned target an
// upload-target response handed back — a plain HTTP POST straight to S3,
// exactly as a real client does and never through the relay. Fields must
// be written before the "file" field: S3 requires that order and ignores
// anything after it.
func uploadBytes(t *testing.T, target harness.UploadTarget, payload []byte) {
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
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		t.Fatalf("upload failed: %d %s", resp.StatusCode, respBody)
	}
}

// putBlob is the whole two-step upload: a target from the relay, then the
// bytes straight to S3.
func putBlob(t *testing.T, c *harness.Circle, entryID string, payload []byte) {
	t.Helper()
	var target harness.UploadTarget
	c.GetUploadTarget(entryID, c.NewUpload()).Expect(http.StatusOK).Decode(&target)
	uploadBytes(t, target, payload)
}

func TestBlobRoundTrip_UploadThenDownloadReturnsTheSameBytes(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	entryID := harness.Suffix()
	payload := []byte("a real photo's ciphertext, or close enough")

	// Nothing uploaded yet. GetDownloadURL always signs successfully — it's
	// pure local signing, never checks existence (see blobstore.Store's doc
	// comment) — so this 404 comes from S3 itself once the relay's redirect
	// is followed, not from the relay refusing outright.
	c.GetBlob(entryID).Expect(http.StatusNotFound)

	putBlob(t, c, entryID, payload)

	got := c.GetBlob(entryID).Expect(http.StatusOK)
	harness.AssertTrue(t, bytes.Equal(got.Bytes(), payload), "downloaded bytes did not match what was uploaded: got %q", got.Bytes())
}

func TestBlobRoundTrip_ASecondUploadTargetForTheSameEntryIsRefused(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	entryID := harness.Suffix()

	putBlob(t, c, entryID, []byte("first"))

	// First-upload-wins (see blobstore.Store.GetUploadTarget): once
	// something has actually landed, a second target for the same entry
	// would let any current member overwrite another's upload.
	c.GetUploadTarget(entryID, c.NewUpload()).Expect(http.StatusConflict)
}

func TestBlobRoundTrip_UploadRequiresTheCurrentWriteToken(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	// Stale: never what createlog recorded. Obtaining an upload URL
	// mutates nothing server-side, but it's a write capability all the
	// same, so it's gated exactly as an append is.
	stale := c.NewUpload()
	stale.WriteToken = harness.NewWriteToken().Raw
	c.GetUploadTarget(harness.Suffix(), stale).Expect(http.StatusForbidden)
}

func TestDeleteBlob_TheUploaderCanDeleteTheirOwnBlob(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	entryID := harness.Suffix()

	putBlob(t, c, entryID, []byte("mine to remove"))

	c.DeleteBlob(entryID, c.NewDeleteBlob()).Expect(http.StatusNoContent)

	c.GetBlob(entryID).Expect(http.StatusNotFound)
}

func TestDeleteBlob_AnotherMemberWithNoSignatureIsRefused(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	entryID := harness.Suffix()

	putBlob(t, c, entryID, []byte("mine, not yours"))

	// A different account holding the same write token — a second device
	// in the same circle. This is the gap the endpoint exists to close: a
	// member who didn't upload it can't destroy it just by being a member.
	other := c.As(r.SignIn())
	other.DeleteBlob(entryID, other.NewDeleteBlob()).Expect(http.StatusForbidden)

	got := c.GetBlob(entryID).Expect(http.StatusOK)
	harness.AssertTrue(t, len(got.Bytes()) > 0, "expected the blob to survive a refused delete")
}

func TestDeleteBlob_AnAdminSignatureDeletesSomeoneElsesUpload(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	entryID := harness.Suffix()

	putBlob(t, c, entryID, []byte("owner's upload, admin's call"))

	other := c.As(r.SignIn())
	other.DeleteBlob(entryID, other.NewAdminDeleteBlob(entryID, c.Admin)).Expect(http.StatusNoContent)

	other.GetBlob(entryID).Expect(http.StatusNotFound)
}

func TestCoverPhoto_RequiresAnAuthoritySignatureAndIsAlwaysOverwritable(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	// The write token alone — proof of membership, not of admin status —
	// isn't enough here, unlike an ordinary entry upload: a cover photo has
	// no per-upload existence check to fall back on (always overwritable),
	// so the admin signature is the only thing standing between it and any
	// current member. An empty one is a bad request, not just a refusal.
	unsigned := c.NewCoverUpload(c.Admin)
	unsigned.AuthorityPublicKey, unsigned.Signature = "", ""
	c.GetCoverPhotoUploadTarget(unsigned).Expect(http.StatusBadRequest)

	// A real signature from a key the circle doesn't recognise gets past
	// the crypto and stops at the authority set.
	c.GetCoverPhotoUploadTarget(c.NewCoverUpload(harness.NewAuthority(t))).Expect(http.StatusForbidden)

	var first harness.UploadTarget
	c.GetCoverPhotoUploadTarget(c.NewCoverUpload(c.Admin)).Expect(http.StatusOK).Decode(&first)
	uploadBytes(t, first, []byte("first cover"))

	got := c.GetBlob("cover").Expect(http.StatusOK)
	harness.AssertEqual(t, string(got.Bytes()), "first cover")

	// Unlike an ordinary entry, a second request for the same cover photo
	// must succeed — overwriting is the whole point.
	var second harness.UploadTarget
	c.GetCoverPhotoUploadTarget(c.NewCoverUpload(c.Admin)).Expect(http.StatusOK).Decode(&second)
	uploadBytes(t, second, []byte("replacement cover"))

	got = c.GetBlob("cover").Expect(http.StatusOK)
	harness.AssertEqual(t, string(got.Bytes()), "replacement cover")
}

func TestDeleteCircle_SweepsItsBlobsToo(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	entryID := harness.Suffix()

	putBlob(t, c, entryID, []byte("gone once the circle is"))

	c.DeleteCircle(c.NewDelete(c.Admin)).Expect(http.StatusOK)

	// The tombstone entry stays — meta survives a deletion (see
	// logstore.Store.DeleteCircle) — but the ciphertext behind this blob
	// must not. This is deletecircle's own call into BlobStore.DeleteCircle,
	// exercised here through the real HTTP surface rather than the store
	// directly (blob_store_test.go already covers the store's sweep itself
	// in isolation).
	c.GetBlob(entryID).Expect(http.StatusNotFound)
}
