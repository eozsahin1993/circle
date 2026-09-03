// Package getcoverphotouploadtarget is the upload-side endpoint for a
// circle's cover photo — POST /circles/{syncId}/cover-photo/upload
// (POST despite not mutating anything server-side, same reasoning as
// getuploadtarget: writeToken/authorityPublicKey/signature belong in the
// body, not query params access logs commonly capture by default).
// Unlike getuploadtarget's ordinary entryID-keyed blobs, a cover photo lives at
// a single fixed, always-overwritable key (see
// blobstore.Store.GetCoverPhotoUploadTarget), so there's no per-upload
// existence check protecting it from being clobbered by any current
// member. Instead this is dual-gated: writeToken proves "a current
// member" (same as every other upload target), and authorityPublicKey +
// signature prove "an admin" — the same capability rotatelog requires,
// checked the same way (see logstore.Store.VerifyAuthoritySignature)
// but here it gates obtaining a URL rather than committing a log entry.
package getcoverphotouploadtarget

import (
	"context"

	"circle-relay/internal/storage/blobstore"
	"circle-relay/internal/storage/logstore"
)

type Service struct {
	BlobStore blobstore.Store
	LogStore  logstore.Store
}

func (s *Service) UploadTarget(ctx context.Context, syncID, writeToken, authorityPublicKey string, signature []byte) (blobstore.UploadTarget, error) {
	if err := s.LogStore.VerifyWriteToken(ctx, syncID, writeToken); err != nil {
		return blobstore.UploadTarget{}, err
	}
	if err := s.LogStore.VerifyAuthoritySignature(ctx, syncID, authorityPublicKey, logstore.CoverPhotoUploadMessage(syncID), signature); err != nil {
		return blobstore.UploadTarget{}, err
	}
	return s.BlobStore.GetCoverPhotoUploadTarget(ctx, syncID)
}
