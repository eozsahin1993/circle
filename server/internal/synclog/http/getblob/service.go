// Package getblob is the whole vertical slice for GET
// /circles/{syncId}/entries/{epoch}/blob.
package getblob

import (
	"context"

	"mimoza-relay/internal/synclog"
)

type Service struct {
	BlobStore synclog.BlobStore
}

func (s *Service) DownloadURL(ctx context.Context, syncID, entryID string) (string, error) {
	return s.BlobStore.GetDownloadURL(ctx, syncID, entryID)
}
