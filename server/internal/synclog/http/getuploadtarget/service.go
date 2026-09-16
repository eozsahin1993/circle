// Package getuploadtarget is the upload-side mirror of getblob's download
// endpoint. Unlike getblob, this requires a write token: obtaining an
// upload URL is a write capability, gated the same way appendlog is
// rather than left open (getblob/getlog's confidentiality comes from
// encryption, not access control). POST, not GET, despite not mutating
// anything server-side — writeToken belongs in the body, not a query
// param that access logs commonly capture by default.
package getuploadtarget

import (
	"context"

	"mimoza-relay/internal/synclog"
)

type Service struct {
	BlobStore synclog.BlobStore
	LogStore  synclog.LogStore
}

// uploaderPublicKey rides onto the object so deleteblob can verify a
// signature from the uploader later — see synclog.BlobStore.GetUploadTarget.
func (s *Service) UploadTarget(ctx context.Context, syncID, entryID, writeToken, uploaderPublicKey string) (synclog.UploadTarget, error) {
	if err := s.LogStore.VerifyWriteToken(ctx, syncID, writeToken); err != nil {
		return synclog.UploadTarget{}, err
	}
	return s.BlobStore.GetUploadTarget(ctx, syncID, entryID, uploaderPublicKey)
}
