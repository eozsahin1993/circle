// Package appendentry is the vertical slice for POST
// /circles/{circleLogId}/entries: its own service, HTTP handler, and route
// registration. Storage (logstore.Store, blobstore.Store) is a shared
// component injected in, not owned by this package.
package appendentry

import (
	"context"

	"circle-relay/internal/storage/blobstore"
	"circle-relay/internal/storage/logstore"
)

// Result is what a successful (or idempotently-retried) append hands back.
type Result struct {
	Epoch      int64
	ReceivedAt int64
	Upload     blobstore.UploadTarget
}

type Service struct {
	LogStore  logstore.Store
	BlobStore blobstore.Store
}

// Append commits the entry, then hands back an upload target —
// unconditionally (see blobstore.Store), even though this pass only ever
// produces entryType "post" entries which always have one. Retention is
// enforced by the store's own TTL, not here — nothing to trim.
func (s *Service) Append(ctx context.Context, circleLogID, entryID string, encryptedMeta []byte) (Result, error) {
	commit, err := s.LogStore.CommitEntry(ctx, circleLogID, entryID, encryptedMeta)
	if err != nil {
		return Result{}, err
	}

	upload, err := s.BlobStore.GetUploadTarget(ctx, circleLogID, commit.Epoch)
	if err != nil {
		return Result{}, err
	}

	return Result{Epoch: commit.Epoch, ReceivedAt: commit.ReceivedAt, Upload: upload}, nil
}
