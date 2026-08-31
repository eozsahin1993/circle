// Package getblob is the whole vertical slice for GET
// /circles/{circleLogId}/entries/{epoch}/blob.
package getblob

import (
	"context"

	"circle-relay/internal/ports"
)

type Service struct {
	BlobStore ports.BlobStore
}

func (s *Service) DownloadURL(ctx context.Context, circleLogID string, epoch int64) (string, error) {
	return s.BlobStore.GetDownloadURL(ctx, circleLogID, epoch)
}
