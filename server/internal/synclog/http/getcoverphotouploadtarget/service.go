// Package getcoverphotouploadtarget is the upload-side endpoint for a
// circle's cover photo — POST /circles/{syncId}/cover-photo/upload
// (POST despite not mutating anything server-side, same reasoning as
// getuploadtarget: writeToken/authorityPublicKey/signature belong in the
// body, not query params access logs commonly capture by default).
// Unlike getuploadtarget's ordinary entryID-keyed blobs, a cover photo lives at
// a single fixed, always-overwritable key (see
// synclog.BlobStore.GetCoverPhotoUploadTarget), so there's no per-upload
// existence check protecting it from being clobbered by any current
// member. Instead this is dual-gated: writeToken proves "a current
// member" (same as every other upload target), and authorityPublicKey +
// signature prove "an admin" — the same capability rotatelog requires,
// checked the same way (see synclog.LogStore.VerifyAuthoritySignature)
// but here it gates obtaining a URL rather than committing a log entry.
package getcoverphotouploadtarget

import (
	"context"

	"mimoza-relay/internal/synclog"
)

type Service struct {
	BlobStore synclog.BlobStore
	LogStore  synclog.LogStore
}

func (s *Service) UploadTarget(ctx context.Context, syncID, writeToken, authorityPublicKey string, signature []byte) (synclog.UploadTarget, error) {
	if err := s.LogStore.VerifyWriteToken(ctx, syncID, writeToken); err != nil {
		return synclog.UploadTarget{}, err
	}
	if err := s.LogStore.VerifyAuthoritySignature(ctx, syncID, authorityPublicKey, synclog.CoverPhotoUploadMessage(syncID), signature); err != nil {
		return synclog.UploadTarget{}, err
	}
	return s.BlobStore.GetCoverPhotoUploadTarget(ctx, syncID)
}
