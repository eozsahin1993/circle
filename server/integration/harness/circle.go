package harness

import (
	"fmt"
	"net/http"
	"testing"

	"circle-relay/internal/storage/logstore"
)

// A circle and the endpoints that act on one. There is a method per
// endpoint under /circles, named for the vertical slice in internal/api
// that serves it — CreateLog, AppendLog, GetLog, RotateLog,
// ChangeAuthority, DeleteCircle — each taking that endpoint's request
// field for field, so what goes on the wire is visible at the call site
// rather than assembled from a map of overrides.
//
// Each request has a New* builder that fills in valid defaults. A test
// takes one, bends the single field it's about, and sends it.
//
// The builders sign with real ed25519 over the message logstore itself
// builds. That means bending a signed field after building leaves a real
// signature over a *different* request — which is exactly what the replay
// tests need, and why they don't have to forge anything.

// The two namespaces, as the wire spells them.
const (
	Meta    = string(logstore.NamespaceMeta)
	Content = string(logstore.NamespaceContent)
)

// Circle is one circle on the relay and everything needed to write to it.
type Circle struct {
	t      *testing.T
	Device *Device
	SyncID string
	// Token is the *current* write capability. MustRotate replaces it,
	// which is what makes a copy taken before a rotation a genuinely stale
	// token rather than an invented wrong one.
	Token WriteToken
	// Admin is the founding authority — the sole member of the circle's
	// authority set until a promotion adds another.
	Admin Authority
}

// UnknownCircle is a syncId the relay has never heard of, carrying
// well-formed capabilities that can't match anything — for the paths that
// have to refuse a circle rather than a credential. Bootstrapping one is
// what makes it a circle, which is exactly what NewCircle does.
func UnknownCircle(t *testing.T, r *Relay) *Circle {
	t.Helper()
	return &Circle{
		t:      t,
		Device: r.SignIn(),
		SyncID: Suffix(),
		Token:  NewWriteToken(),
		Admin:  NewAuthority(t),
	}
}

func NewCircle(t *testing.T, r *Relay) *Circle {
	t.Helper()
	c := UnknownCircle(t, r)
	c.CreateLog(c.NewCreate()).Expect(http.StatusCreated)
	return c
}

func (c *Circle) Path() string { return "/v1/circles/" + c.SyncID }

// CreateRequest is POST /circles/{syncId} — see internal/api/createlog.
type CreateRequest struct {
	FounderAuthorityPublicKey string `json:"founderAuthorityPublicKey"`
	InitialWriteTokenHash     string `json:"initialWriteTokenHash"`
}

func (c *Circle) NewCreate() CreateRequest {
	return CreateRequest{
		FounderAuthorityPublicKey: c.Admin.PublicKey(),
		InitialWriteTokenHash:     c.Token.Hash,
	}
}

func (c *Circle) CreateLog(req CreateRequest) Response {
	return c.Device.PostRequest(c.Path(), req)
}

// AppendRequest is POST /circles/{syncId}/entries — see
// internal/api/appendlog.
type AppendRequest struct {
	Namespace string `json:"namespace"`
	EntryID   string `json:"entryId"`
	// EncryptedMeta is ciphertext the relay never reads (SYNC_DESIGN
	// invariant 3). Nothing about an append turns on its contents, so
	// NewAppend fills it with random bytes; a test asserting the payload
	// comes back intact sets its own.
	EncryptedMeta string `json:"encryptedMeta"`
	KeyVersion    int64  `json:"keyVersion"`
	WriteToken    string `json:"writeToken"`
}

// NewAppend is a valid append of one new entry to ns.
func (c *Circle) NewAppend(ns string) AppendRequest {
	return AppendRequest{
		Namespace:     ns,
		EntryID:       Suffix(),
		EncryptedMeta: Ciphertext(),
		KeyVersion:    1,
		WriteToken:    c.Token.Raw,
	}
}

func (c *Circle) AppendLog(req AppendRequest) Response {
	return c.Device.PostRequest(c.Path()+"/entries", req)
}

// MustAppend puts one entry in ns for a sequence that needs an entry to
// exist and doesn't care which — see NewAppend for what's in it.
func (c *Circle) MustAppend(ns string) Commit {
	c.t.Helper()
	var result Commit
	c.AppendLog(c.NewAppend(ns)).Expect(http.StatusOK).Decode(&result)
	return result
}

// Commit is what every write path hands back: where the entry landed.
type Commit struct {
	Epoch      int64
	ReceivedAt int64
}

type LogEntry struct {
	Epoch         int64
	KeyVersion    int64
	EncryptedMeta string
	ReceivedAt    int64
}

type LogPage struct {
	Entries      []LogEntry
	CurrentEpoch int64
}

// GetLog is GET /circles/{syncId}/entries — see internal/api/getlog. One
// page of ns, everything strictly after since. Takes no write token: the
// relay gates reads on a session alone.
func (c *Circle) GetLog(ns string, since int64) LogPage {
	c.t.Helper()
	var page LogPage
	c.Device.Get(fmt.Sprintf("%s/entries?namespace=%s&since=%d", c.Path(), ns, since)).
		Expect(http.StatusOK).Decode(&page)
	return page
}

// Entries is a whole namespace from the beginning — what a device joining
// today replays.
func (c *Circle) Entries(ns string) []LogEntry {
	c.t.Helper()
	return c.GetLog(ns, 0).Entries
}

// PeekEpochs is POST /epochs/peek — see internal/api/getepochs. What a
// device polling for changes is told, for this circle alone; a syncId the
// relay has no control state for comes back absent, which reads here as
// two zeroes.
func (c *Circle) PeekEpochs() (metaEpoch, contentEpoch int64) {
	c.t.Helper()
	var peeked struct {
		Circles []struct {
			SyncID       string
			MetaEpoch    int64
			ContentEpoch int64
		}
	}
	c.Device.Post("/v1/epochs/peek", Body{"syncIds": []string{c.SyncID}}).
		Expect(http.StatusOK).Decode(&peeked)

	if len(peeked.Circles) == 0 {
		return 0, 0
	}
	return peeked.Circles[0].MetaEpoch, peeked.Circles[0].ContentEpoch
}

// RotateRequest is POST /circles/{syncId}/rotate — see
// internal/api/rotatelog.
type RotateRequest struct {
	EntryID       string `json:"entryId"`
	EncryptedMeta string `json:"encryptedMeta"`
	// CurrentKeyVersion is the *pre*-rotation version, always: the
	// key_rotation entry is encrypted under the key being rotated away
	// from, or nobody could read it.
	CurrentKeyVersion  int64  `json:"currentKeyVersion"`
	CurrentWriteToken  string `json:"currentWriteToken"`
	NewWriteTokenHash  string `json:"newWriteTokenHash"`
	AuthorityPublicKey string `json:"authorityPublicKey"`
	Signature          string `json:"signature"`
}

// NewRotate is a valid rotation to next, signed by signer.
func (c *Circle) NewRotate(next WriteToken, signer Authority) RotateRequest {
	entryID := Suffix()
	return RotateRequest{
		EntryID:            entryID,
		EncryptedMeta:      Ciphertext(),
		CurrentKeyVersion:  1,
		CurrentWriteToken:  c.Token.Raw,
		NewWriteTokenHash:  next.Hash,
		AuthorityPublicKey: signer.PublicKey(),
		Signature:          signer.Sign(logstore.RotateMessage(c.SyncID, entryID, next.Hash)),
	}
}

// RotateLog sends req as it stands and leaves c.Token alone — a rotation
// that doesn't land must leave the circle writable with the token it
// already had. Use MustRotate for one that's meant to succeed.
func (c *Circle) RotateLog(req RotateRequest) Response {
	return c.Device.PostRequest(c.Path()+"/rotate", req)
}

// MustRotate rotates and adopts the token it minted, since every later
// write has to present the new one.
func (c *Circle) MustRotate(signer Authority) Commit {
	c.t.Helper()
	next := NewWriteToken()

	var result Commit
	c.RotateLog(c.NewRotate(next, signer)).Expect(http.StatusOK).Decode(&result)

	c.Token = next
	return result
}

// AuthorityRequest is POST /circles/{syncId}/authority — see
// internal/api/changeauthority.
type AuthorityRequest struct {
	EntryID       string `json:"entryId"`
	EncryptedMeta string `json:"encryptedMeta"`
	KeyVersion    int64  `json:"keyVersion"`
	WriteToken    string `json:"writeToken"`

	Action                   string `json:"action"`
	TargetAuthorityPublicKey string `json:"targetAuthorityPublicKey"`
	SignerAuthorityPublicKey string `json:"signerAuthorityPublicKey"`
	Signature                string `json:"signature"`
}

// NewAuthorityChange is a valid move of target across the authority set,
// signed by signer.
func (c *Circle) NewAuthorityChange(action logstore.AuthorityAction, target string, signer Authority) AuthorityRequest {
	entryID := Suffix()
	change := logstore.AuthorityChange{
		Action:                   action,
		SyncID:                   c.SyncID,
		EntryID:                  entryID,
		TargetAuthorityPublicKey: target,
	}
	return AuthorityRequest{
		EntryID:                  entryID,
		EncryptedMeta:            Ciphertext(),
		KeyVersion:               1,
		WriteToken:               c.Token.Raw,
		Action:                   string(action),
		TargetAuthorityPublicKey: target,
		SignerAuthorityPublicKey: signer.PublicKey(),
		Signature:                signer.Sign(change.Message()),
	}
}

func (c *Circle) ChangeAuthority(req AuthorityRequest) Response {
	return c.Device.PostRequest(c.Path()+"/authority", req)
}

// Promote and Demote are ChangeAuthority under the two names a reader of
// a sequence actually thinks in.
func (c *Circle) Promote(target string, signer Authority) Response {
	return c.ChangeAuthority(c.NewAuthorityChange(logstore.AuthorityAdd, target, signer))
}

func (c *Circle) Demote(target string, signer Authority) Response {
	return c.ChangeAuthority(c.NewAuthorityChange(logstore.AuthorityRemove, target, signer))
}

// DeleteRequest is POST /circles/{syncId}/delete — see
// internal/api/deletecircle.
type DeleteRequest struct {
	EntryID       string `json:"entryId"`
	EncryptedMeta string `json:"encryptedMeta"`
	KeyVersion    int64  `json:"keyVersion"`
	WriteToken    string `json:"writeToken"`

	SignerAuthorityPublicKey string `json:"signerAuthorityPublicKey"`
	Signature                string `json:"signature"`
}

// NewDelete is a valid deletion signed by signer. Built separately from
// the call so a test can send the same one twice: a resend is a retry that
// re-runs the sweep, while a second deletion under a *fresh* entry id is a
// new write to a circle that's already gone, which the relay refuses.
func (c *Circle) NewDelete(signer Authority) DeleteRequest {
	entryID := Suffix()
	deletion := logstore.CircleDeletion{SyncID: c.SyncID, EntryID: entryID}
	return DeleteRequest{
		EntryID:                  entryID,
		EncryptedMeta:            Ciphertext(),
		KeyVersion:               1,
		WriteToken:               c.Token.Raw,
		SignerAuthorityPublicKey: signer.PublicKey(),
		Signature:                signer.Sign(deletion.Message()),
	}
}

func (c *Circle) DeleteCircle(req DeleteRequest) Response {
	return c.Device.PostRequest(c.Path()+"/delete", req)
}

// As is the same circle acted on by a different device — a second phone
// in the circle, or an account that isn't in it at all. The capabilities
// travel with the circle, the session with the device, and deleteblob is
// the endpoint that cares which account is calling.
func (c *Circle) As(d *Device) *Circle {
	acting := *c
	acting.Device = d
	return &acting
}

// UploadTarget is what the two upload-target endpoints hand back: a
// presigned S3 POST a client uses directly, never back through the relay
// (see server/DESIGN.md).
type UploadTarget struct {
	URL    string            `json:"url"`
	Fields map[string]string `json:"fields"`
}

// UploadRequest is POST /circles/{syncId}/entries/{entryId}/upload — see
// internal/api/getuploadtarget. Membership alone, since an entry's blob
// is first-upload-wins and can't be overwritten.
type UploadRequest struct {
	WriteToken string `json:"writeToken"`
}

func (c *Circle) NewUpload() UploadRequest {
	return UploadRequest{WriteToken: c.Token.Raw}
}

func (c *Circle) GetUploadTarget(entryID string, req UploadRequest) Response {
	return c.Device.PostRequest(c.entryPath(entryID)+"/upload", req)
}

// GetBlob is GET /circles/{syncId}/entries/{entryId}/blob — see
// internal/api/getblob. The relay redirects to a presigned URL, so a 404
// here is S3 saying nothing was ever uploaded, not the relay refusing.
func (c *Circle) GetBlob(entryID string) Response {
	return c.Device.Get(c.entryPath(entryID) + "/blob")
}

// DeleteBlobRequest is POST
// /circles/{syncId}/entries/{entryId}/delete-blob — see
// internal/api/deleteblob. The authority fields are optional: the
// uploading account needs neither, since the session already says who
// that is. Anyone else needs an admin signature over
// logstore.DeleteBlobMessage.
type DeleteBlobRequest struct {
	WriteToken         string `json:"writeToken"`
	AuthorityPublicKey string `json:"authorityPublicKey"`
	Signature          string `json:"signature"`
}

// NewDeleteBlob deletes as the uploader — no signature, which is the
// whole point of that path.
func (c *Circle) NewDeleteBlob() DeleteBlobRequest {
	return DeleteBlobRequest{WriteToken: c.Token.Raw}
}

// NewAdminDeleteBlob deletes somebody else's upload, signed by signer.
func (c *Circle) NewAdminDeleteBlob(entryID string, signer Authority) DeleteBlobRequest {
	return DeleteBlobRequest{
		WriteToken:         c.Token.Raw,
		AuthorityPublicKey: signer.PublicKey(),
		Signature:          signer.Sign(logstore.DeleteBlobMessage(c.SyncID, entryID)),
	}
}

func (c *Circle) DeleteBlob(entryID string, req DeleteBlobRequest) Response {
	return c.Device.PostRequest(c.entryPath(entryID)+"/delete-blob", req)
}

// CoverUploadRequest is POST /circles/{syncId}/cover-photo/upload — see
// internal/api/getcoverphotouploadtarget. Unlike an entry's blob this one
// is always overwritable, so there's no existence check to fall back on
// and the admin signature is all that stands between the cover and any
// current member.
type CoverUploadRequest struct {
	WriteToken         string `json:"writeToken"`
	AuthorityPublicKey string `json:"authorityPublicKey"`
	Signature          string `json:"signature"`
}

func (c *Circle) NewCoverUpload(signer Authority) CoverUploadRequest {
	return CoverUploadRequest{
		WriteToken:         c.Token.Raw,
		AuthorityPublicKey: signer.PublicKey(),
		Signature:          signer.Sign(logstore.CoverPhotoUploadMessage(c.SyncID)),
	}
}

func (c *Circle) GetCoverPhotoUploadTarget(req CoverUploadRequest) Response {
	return c.Device.PostRequest(c.Path()+"/cover-photo/upload", req)
}

func (c *Circle) entryPath(entryID string) string { return c.Path() + "/entries/" + entryID }

// EpochSequence renders a page's epochs for the assertions about ordering
// rather than about one entry. A string because Go can't compare slices,
// and "[1 2 3]" against "[1 3]" says more on failure than a length does.
func EpochSequence(entries []LogEntry) string {
	got := make([]int64, len(entries))
	for i, entry := range entries {
		got[i] = entry.Epoch
	}
	return fmt.Sprint(got)
}
