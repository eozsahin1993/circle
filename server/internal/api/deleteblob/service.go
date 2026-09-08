// Package deleteblob removes one blob's ciphertext —
// POST /circles/{syncId}/entries/{entryId}/delete-blob (POST for the same
// reason as getuploadtarget: credentials belong in a body).
//
// The only relay endpoint that removes anything, and only bytes: the
// entries naming the blob stay, so replay still converges.
//
// Clients enforce "the photo's author or an admin" from the post's author
// key, which is inside the ciphertext. The relay can't read that, so it
// gates on who uploaded the object or on an admin signature — author and
// uploader coincide, since a post's blob is uploaded by the device that
// authors its entry.
//
// The write token alone is deliberately not enough. It proves "a current
// member", which would let any member destroy bytes for everyone who
// hadn't downloaded them yet — unlike a forged `post_delete` entry, which
// every device rejects on its predicate.
package deleteblob

import (
	"context"
	"errors"

	"circle-relay/internal/storage/blobstore"
	"circle-relay/internal/storage/logstore"
)

type Service struct {
	BlobStore blobstore.Store
	LogStore  logstore.Store
}

// ErrNotUploader: a member, but not one entitled to destroy this object
// — distinct from a write-token mismatch.
var ErrNotUploader = errors.New("deleteblob: caller did not upload this blob")

// Delete removes the blob if accountID uploaded it, or if
// authorityPublicKey + signature prove an admin authorized it. A blob
// that isn't there is a success: the client retries from its outbox, so
// the attempt after a successful one must not read as a failure.
func (s *Service) Delete(
	ctx context.Context,
	syncID, entryID, writeToken, accountID, authorityPublicKey string,
	signature []byte,
) error {
	if err := s.LogStore.VerifyWriteToken(ctx, syncID, writeToken); err != nil {
		return err
	}

	uploader, err := s.BlobStore.UploaderAccountID(ctx, syncID, entryID)
	if errors.Is(err, blobstore.ErrBlobNotFound) {
		return nil
	}
	if err != nil {
		return err
	}

	// An empty uploader predates uploader recording: nobody can claim it,
	// so an admin signature is the only way in.
	if uploader == "" || uploader != accountID {
		if authorityPublicKey == "" || len(signature) == 0 {
			return ErrNotUploader
		}
		if err := s.LogStore.VerifyAuthoritySignature(
			ctx,
			syncID,
			authorityPublicKey,
			logstore.DeleteBlobMessage(syncID, entryID),
			signature,
		); err != nil {
			return err
		}
	}

	return s.BlobStore.Delete(ctx, syncID, entryID)
}
