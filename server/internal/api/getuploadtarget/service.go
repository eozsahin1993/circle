// Package getuploadtarget is the upload-side mirror of getblob's download
// endpoint. Unlike getblob, this requires a write token: obtaining an
// upload URL is a write capability despite being a GET, so it's gated
// the same way appendlog is rather than left open (getblob/getlog's
// confidentiality comes from encryption, not access control).
package getuploadtarget

import (
	"context"

	"circle-relay/internal/storage/blobstore"
	"circle-relay/internal/storage/logstore"
)

type Service struct {
	BlobStore blobstore.Store
	LogStore  logstore.Store
}

func (s *Service) UploadTarget(ctx context.Context, syncID, entryID, writeToken string) (blobstore.UploadTarget, error) {
	if err := s.LogStore.VerifyWriteToken(ctx, syncID, writeToken); err != nil {
		return blobstore.UploadTarget{}, err
	}
	return s.BlobStore.GetUploadTarget(ctx, syncID, entryID)
}
