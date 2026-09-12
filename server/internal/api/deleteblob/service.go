// Package deleteblob removes one blob's ciphertext —
// POST /circles/{syncId}/entries/{entryId}/delete-blob (POST for the same
// reason as getuploadtarget: credentials belong in a body).
//
// The only relay endpoint that removes anything, and only bytes: the
// entries naming the blob stay, so replay still converges.
//
// Gated on a signature from whoever uploaded the blob, or an admin
// signature otherwise — the relay can't apply the clients' own
// author-or-admin rule directly, since the author's key is inside the
// ciphertext. A write token alone isn't enough (it only proves "a current
// member," letting anyone destroy bytes nobody else has downloaded yet),
// and nor is a bare comparison against the recorded public key (every
// member already sees it via attribution, so knowing it proves nothing —
// only a signature, proof of the matching private key, actually does).
package deleteblob

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
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

// Delete removes the blob if uploaderSignature verifies against the
// public key recorded at upload time, or if authorityPublicKey +
// authoritySignature prove an admin authorized it. A blob that isn't
// there is a success: the client retries from its outbox, so the attempt
// after a successful one must not read as a failure.
func (s *Service) Delete(
	ctx context.Context,
	syncID, entryID, writeToken, uploaderSignature, authorityPublicKey string,
	authoritySignature []byte,
) error {
	if err := s.LogStore.VerifyWriteToken(ctx, syncID, writeToken); err != nil {
		return err
	}

	uploaderPublicKey, err := s.BlobStore.UploaderPublicKey(ctx, syncID, entryID)
	if errors.Is(err, blobstore.ErrBlobNotFound) {
		return nil
	}
	if err != nil {
		return err
	}

	if !verifiesAsUploader(uploaderPublicKey, uploaderSignature, syncID, entryID) {
		if authorityPublicKey == "" || len(authoritySignature) == 0 {
			return ErrNotUploader
		}
		if err := s.LogStore.VerifyAuthoritySignature(
			ctx,
			syncID,
			authorityPublicKey,
			logstore.DeleteBlobMessage(syncID, entryID),
			authoritySignature,
		); err != nil {
			return err
		}
	}

	return s.BlobStore.Delete(ctx, syncID, entryID)
}

// verifiesAsUploader reports whether signatureHex proves possession of
// publicKeyHex's private key, over the delete-blob message. Malformed or
// missing input is simply not a match, never an error — either an empty
// publicKeyHex (predates uploader recording) or an absent signature just
// leaves the admin-signature path to carry the day.
func verifiesAsUploader(publicKeyHex, signatureHex, syncID, entryID string) bool {
	if publicKeyHex == "" || signatureHex == "" {
		return false
	}
	publicKey, err := hex.DecodeString(publicKeyHex)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return false
	}
	signature, err := hex.DecodeString(signatureHex)
	if err != nil {
		return false
	}
	return ed25519.Verify(publicKey, logstore.DeleteBlobMessage(syncID, entryID), signature)
}
