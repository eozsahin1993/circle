package integration_test

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"mime/multipart"
	"net/http"
	"testing"

	"circle-relay/integration/harness"
	"circle-relay/internal/storage/logstore"
)

// Blob endpoints, end to end against a real S3 (LocalStack): a presigned
// upload target obtained through the relay, used the way a client
// actually uses it (a plain POST straight to S3, never back through the
// relay — see server/DESIGN.md), then read back through the relay's own
// redirect and deleted through it. internal/storage/blobstore/s3's own
// tests already prove the store's behaviour in isolation; what's missing
// there is the session, write-token and authority-signature gates in
// front of it, which only exist in the API layer these tests drive.
//
// Sequenced like invite_test.go: a circle is bootstrapped, then acted on
// through the same HTTP surface a client uses.

func newToken(t *testing.T) string {
	t.Helper()
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(buf)
}

func hashToken(tokenHex string) string {
	raw, _ := hex.DecodeString(tokenHex)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// circle is what bootstrapping hands back: the admin keypair and write
// token a test needs to act on it, plus its syncID. Unlike invite_test.go's
// device, this wraps state rather than a *harness.Device — every call here
// names which device is acting, since who's calling is the point of half
// these tests.
type circle struct {
	syncID      string
	writeToken  string
	founderPub  ed25519.PublicKey
	founderPriv ed25519.PrivateKey
}

func bootstrapCircle(t *testing.T, owner *harness.Device) circle {
	t.Helper()
	founderPub, founderPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	syncID := harness.Suffix()
	writeToken := newToken(t)

	owner.Post("/v1/circles/"+syncID, harness.Body{
		"founderAuthorityPublicKey": hex.EncodeToString(founderPub),
		"initialWriteTokenHash":     hashToken(writeToken),
	}).Expect(http.StatusCreated)

	return circle{syncID: syncID, writeToken: writeToken, founderPub: founderPub, founderPriv: founderPriv}
}

func (c circle) uploadPath(entryID string) string {
	return "/v1/circles/" + c.syncID + "/entries/" + entryID + "/upload"
}
func (c circle) blobPath(entryID string) string {
	return "/v1/circles/" + c.syncID + "/entries/" + entryID + "/blob"
}
func (c circle) deleteBlobPath(entryID string) string {
	return "/v1/circles/" + c.syncID + "/entries/" + entryID + "/delete-blob"
}
func (c circle) coverUploadPath() string { return "/v1/circles/" + c.syncID + "/cover-photo/upload" }
func (c circle) deletePath() string      { return "/v1/circles/" + c.syncID + "/delete" }

type uploadTargetResponse struct {
	URL    string            `json:"url"`
	Fields map[string]string `json:"fields"`
}

func (c circle) uploadTarget(d *harness.Device, entryID string) harness.Response {
	return d.Post(c.uploadPath(entryID), harness.Body{"writeToken": c.writeToken})
}

func (c circle) deleteBlob(d *harness.Device, entryID, authorityPublicKey, signatureHex string) harness.Response {
	return d.Post(c.deleteBlobPath(entryID), harness.Body{
		"writeToken":         c.writeToken,
		"authorityPublicKey": authorityPublicKey,
		"signature":          signatureHex,
	})
}

func (c circle) coverUploadTarget(d *harness.Device, authorityPublicKey, signatureHex string) harness.Response {
	return d.Post(c.coverUploadPath(), harness.Body{
		"writeToken":         c.writeToken,
		"authorityPublicKey": authorityPublicKey,
		"signature":          signatureHex,
	})
}

func (c circle) deleteCircle(d *harness.Device, tombstoneEntryID string) harness.Response {
	signature := ed25519.Sign(c.founderPriv, logstore.CircleDeletion{SyncID: c.syncID, EntryID: tombstoneEntryID}.Message())
	return d.Post(c.deletePath(), harness.Body{
		"entryId":                  tombstoneEntryID,
		"encryptedMeta":            harness.Ciphertext(),
		"keyVersion":               1,
		"writeToken":               c.writeToken,
		"signerAuthorityPublicKey": hex.EncodeToString(c.founderPub),
		"signature":                hex.EncodeToString(signature),
	})
}

// uploadBytes performs the actual upload against the presigned target a
// getuploadtarget/getcoverphotouploadtarget response handed back — a plain
// HTTP POST straight to S3, exactly as a real client does and never
// through the relay. Fields must be written before the "file" field: S3
// requires that order and ignores anything after it.
func uploadBytes(t *testing.T, url string, fields map[string]string, payload []byte) {
	t.Helper()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range fields {
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

	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, url, &body)
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

func TestBlobRoundTrip_UploadThenDownloadReturnsTheSameBytes(t *testing.T) {
	r := harness.Start(t)
	owner := r.SignIn()
	c := bootstrapCircle(t, owner)
	entryID := harness.Suffix()
	payload := []byte("a real photo's ciphertext, or close enough")

	// Nothing uploaded yet. GetDownloadURL always signs successfully — it's
	// pure local signing, never checks existence (see blobstore.Store's doc
	// comment) — so this 404 comes from S3 itself once the relay's redirect
	// is followed, not from the relay refusing outright.
	owner.Get(c.blobPath(entryID)).Expect(http.StatusNotFound)

	var target uploadTargetResponse
	c.uploadTarget(owner, entryID).Expect(http.StatusOK).Decode(&target)
	uploadBytes(t, target.URL, target.Fields, payload)

	got := owner.Get(c.blobPath(entryID)).Expect(http.StatusOK)
	harness.AssertTrue(t, bytes.Equal(got.Bytes(), payload), "downloaded bytes did not match what was uploaded: got %q", got.Bytes())
}

func TestBlobRoundTrip_ASecondUploadTargetForTheSameEntryIsRefused(t *testing.T) {
	r := harness.Start(t)
	owner := r.SignIn()
	c := bootstrapCircle(t, owner)
	entryID := harness.Suffix()

	var target uploadTargetResponse
	c.uploadTarget(owner, entryID).Expect(http.StatusOK).Decode(&target)
	uploadBytes(t, target.URL, target.Fields, []byte("first"))

	// First-upload-wins (see blobstore.Store.GetUploadTarget): once
	// something has actually landed, a second target for the same entry
	// would let any current member overwrite another's upload.
	c.uploadTarget(owner, entryID).Expect(http.StatusConflict)
}

func TestBlobRoundTrip_UploadRequiresTheCurrentWriteToken(t *testing.T) {
	r := harness.Start(t)
	owner := r.SignIn()
	c := bootstrapCircle(t, owner)
	c.writeToken = newToken(t) // stale: never what Bootstrap recorded

	c.uploadTarget(owner, harness.Suffix()).Expect(http.StatusForbidden)
}

func TestDeleteBlob_TheUploaderCanDeleteTheirOwnBlob(t *testing.T) {
	r := harness.Start(t)
	owner := r.SignIn()
	c := bootstrapCircle(t, owner)
	entryID := harness.Suffix()

	var target uploadTargetResponse
	c.uploadTarget(owner, entryID).Expect(http.StatusOK).Decode(&target)
	uploadBytes(t, target.URL, target.Fields, []byte("mine to remove"))

	c.deleteBlob(owner, entryID, "", "").Expect(http.StatusNoContent)

	owner.Get(c.blobPath(entryID)).Expect(http.StatusNotFound)
}

func TestDeleteBlob_AnotherMemberWithNoSignatureIsRefused(t *testing.T) {
	r := harness.Start(t)
	owner := r.SignIn()
	c := bootstrapCircle(t, owner)
	entryID := harness.Suffix()

	var target uploadTargetResponse
	c.uploadTarget(owner, entryID).Expect(http.StatusOK).Decode(&target)
	uploadBytes(t, target.URL, target.Fields, []byte("mine, not yours"))

	// A different account holding the same write token — a second device
	// in the same circle. This is the gap the endpoint exists to close: a
	// member who didn't upload it can't destroy it just by being a member.
	other := r.SignIn()
	c.deleteBlob(other, entryID, "", "").Expect(http.StatusForbidden)

	got := owner.Get(c.blobPath(entryID)).Expect(http.StatusOK)
	harness.AssertTrue(t, len(got.Bytes()) > 0, "expected the blob to survive a refused delete")
}

func TestDeleteBlob_AnAdminSignatureDeletesSomeoneElsesUpload(t *testing.T) {
	r := harness.Start(t)
	owner := r.SignIn()
	c := bootstrapCircle(t, owner)
	entryID := harness.Suffix()

	var target uploadTargetResponse
	c.uploadTarget(owner, entryID).Expect(http.StatusOK).Decode(&target)
	uploadBytes(t, target.URL, target.Fields, []byte("owner's upload, admin's call"))

	other := r.SignIn()
	signature := ed25519.Sign(c.founderPriv, logstore.DeleteBlobMessage(c.syncID, entryID))
	c.deleteBlob(other, entryID, hex.EncodeToString(c.founderPub), hex.EncodeToString(signature)).Expect(http.StatusNoContent)

	other.Get(c.blobPath(entryID)).Expect(http.StatusNotFound)
}

func TestCoverPhoto_RequiresAnAuthoritySignatureAndIsAlwaysOverwritable(t *testing.T) {
	r := harness.Start(t)
	owner := r.SignIn()
	c := bootstrapCircle(t, owner)

	// The write token alone — proof of membership, not of admin status —
	// isn't enough here, unlike an ordinary entry upload: a cover photo has
	// no per-upload existence check to fall back on (always overwritable),
	// so the admin signature is the only thing standing between it and any
	// current member. An empty one is a bad request, not just a refusal.
	c.coverUploadTarget(owner, "", "").Expect(http.StatusBadRequest)

	strangerPub, strangerPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	strangerSig := ed25519.Sign(strangerPriv, logstore.CoverPhotoUploadMessage(c.syncID))
	c.coverUploadTarget(owner, hex.EncodeToString(strangerPub), hex.EncodeToString(strangerSig)).Expect(http.StatusForbidden)

	sign := func() string {
		return hex.EncodeToString(ed25519.Sign(c.founderPriv, logstore.CoverPhotoUploadMessage(c.syncID)))
	}

	var first uploadTargetResponse
	c.coverUploadTarget(owner, hex.EncodeToString(c.founderPub), sign()).Expect(http.StatusOK).Decode(&first)
	uploadBytes(t, first.URL, first.Fields, []byte("first cover"))

	got := owner.Get(c.blobPath("cover")).Expect(http.StatusOK)
	harness.AssertEqual(t, string(got.Bytes()), "first cover")

	// Unlike an ordinary entry, a second request for the same cover photo
	// must succeed — overwriting is the whole point.
	var second uploadTargetResponse
	c.coverUploadTarget(owner, hex.EncodeToString(c.founderPub), sign()).Expect(http.StatusOK).Decode(&second)
	uploadBytes(t, second.URL, second.Fields, []byte("replacement cover"))

	got = owner.Get(c.blobPath("cover")).Expect(http.StatusOK)
	harness.AssertEqual(t, string(got.Bytes()), "replacement cover")
}

func TestDeleteCircle_SweepsItsBlobsToo(t *testing.T) {
	r := harness.Start(t)
	owner := r.SignIn()
	c := bootstrapCircle(t, owner)
	entryID := harness.Suffix()

	var target uploadTargetResponse
	c.uploadTarget(owner, entryID).Expect(http.StatusOK).Decode(&target)
	uploadBytes(t, target.URL, target.Fields, []byte("gone once the circle is"))

	c.deleteCircle(owner, harness.Suffix()).Expect(http.StatusOK)

	// The tombstone entry stays — meta survives a deletion (see
	// logstore.Store.DeleteCircle) — but the ciphertext behind this blob
	// must not. This is deletecircle's own call into BlobStore.DeleteCircle,
	// exercised here through the real HTTP surface rather than the store
	// directly (blob_store_test.go already covers the store's sweep itself
	// in isolation).
	owner.Get(c.blobPath(entryID)).Expect(http.StatusNotFound)
}
