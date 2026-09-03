// Package getblob is the whole vertical slice for GET
// /circles/{syncId}/entries/{epoch}/blob.
package getblob

import (
	"context"

	"circle-relay/internal/storage/blobstore"
)

type Service struct {
	BlobStore blobstore.Store
}

func (s *Service) DownloadURL(ctx context.Context, syncID, entryID string) (string, error) {
	return s.BlobStore.GetDownloadURL(ctx, syncID, entryID)
}
