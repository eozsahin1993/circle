// Package blobstore defines the interface domain logic depends on for blob
// storage — implementations live in subpackages, one per backing
// technology (see blobstore/s3). Nothing storage- or runtime-specific is
// allowed to leak past this package.
package blobstore

import (
	"context"
	"errors"
)

// UploadTarget is a presigned S3 POST (URL plus required form fields), not
// a bare PUT URL — a POST policy is what lets the max blob size be
// enforced by S3 itself via a signed content-length-range condition,
// instead of trusting the client or checking after the fact.
type UploadTarget struct {
	URL    string
	Fields map[string]string
}

// ErrBlobAlreadyExists: GetUploadTarget refused because something is
// already uploaded at this key — blobs are single-use, first-upload-wins.
// See GetUploadTarget's doc comment for why.
var ErrBlobAlreadyExists = errors.New("blobstore: a blob already exists for this entry")

// ErrBlobNotFound: nothing is stored at this key. Only Uploader reports
// it — Delete treats a missing object as already deleted.
var ErrBlobNotFound = errors.New("blobstore: no blob for this entry")

// Store is storage for the (large, encrypted) blob behind one log entry.
// GetDownloadURL always succeeds and costs nothing to hand out — pure
// local signing — so callers never check "does this entry have a blob"
// first. GetUploadTarget is different: it checks first and can fail.
//
// Keyed by entryID, not epoch — a client can obtain and use an upload
// target *before* the entry referencing it is committed. Uploading the
// blob first means a crash in between leaves a harmless orphaned blob
// rather than a permanent entry pointing at nothing, unfixable in an
// immutable log.
type Store interface {
	// GetUploadTarget returns a short-lived presigned POST for this exact
	// entry, capped at the store's max blob size — or ErrBlobAlreadyExists
	// if something is already there. Single-use, first-upload-wins:
	// without this, any current member could re-request a target for an
	// entryID they didn't create and overwrite it with a replacement that
	// still decrypts successfully — a write token proves "a current
	// member," never "the original author," so it can't close this alone.
	// uploaderAccountID is recorded on the object for Delete to gate on
	// later — the closest the relay can get to the clients' author rule,
	// since the author's circle identity key is inside the ciphertext.
	GetUploadTarget(ctx context.Context, syncID, entryID, uploaderAccountID string) (UploadTarget, error)

	// GetCoverPhotoUploadTarget returns a short-lived presigned POST for a
	// circle's cover photo — always the same key (entryID "cover"; see
	// GetDownloadURL, which needs no changes to read it back), and always
	// overwritable, unlike GetUploadTarget: a new cover photo is meant to
	// replace the old one, not collide with it, so there's no
	// already-exists check here. Safe from the same insider-overwrite risk
	// GetUploadTarget's check guards against only because the API layer
	// gates issuing this specifically on an authority (admin) signature —
	// see logstore.Store.VerifyAuthoritySignature — not just possession of
	// the write token every other upload target accepts.
	GetCoverPhotoUploadTarget(ctx context.Context, syncID string) (UploadTarget, error)

	// GetDownloadURL returns a short-lived URL the client can GET
	// ciphertext bytes from. It 404s on use if nothing was ever uploaded
	// there — that's expected, not an error here.
	GetDownloadURL(ctx context.Context, syncID, entryID string) (string, error)

	// UploaderAccountID returns the account GetUploadTarget recorded, or
	// ErrBlobNotFound if nothing is stored. Empty for a blob predating
	// uploader recording: unknown, never a match.
	UploaderAccountID(ctx context.Context, syncID, entryID string) (string, error)

	// Delete removes a blob's bytes — the one thing the relay ever
	// removes. Idempotent, so the client can retry it. The entries naming
	// the blob stay, immutable — the log is never mutated or rewritten;
	// only the ciphertext goes.
	Delete(ctx context.Context, syncID, entryID string) error

	// DeleteCircle removes every blob a circle owns, cover photo included
	// — they all share the syncID prefix. Idempotent and resumable: a
	// caller that fails partway retries the whole thing, and objects
	// already gone are simply absent from the next listing.
	DeleteCircle(ctx context.Context, syncID string) error
}
