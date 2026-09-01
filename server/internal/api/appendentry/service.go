// Package appendentry is the vertical slice for POST
// /circles/{circleLogId}/entries: its own service, HTTP handler, and route
// registration. Storage (ports.LogStore, ports.BlobStore) is a shared
// component injected in, not owned by this package.
package appendentry

import (
	"context"

	"circle-relay/internal/ports"
)

// Result is what a successful (or idempotently-retried) append hands back.
type Result struct {
	Epoch      int64
	ReceivedAt int64
	Upload     ports.UploadTarget
}

type Service struct {
	LogStore  ports.LogStore
	BlobStore ports.BlobStore
}

// Append commits the entry, then always trims (cheap no-op when nothing's
// over the ring buffer cap) and hands back an upload target — unconditionally
// (see ports.BlobStore), even though this pass only ever produces
// entryType "post" entries which always have one.
func (s *Service) Append(ctx context.Context, circleLogID, entryID string, encryptedMeta []byte) (Result, error) {
	commit, err := s.LogStore.CommitEntry(ctx, circleLogID, entryID, encryptedMeta)
	if err != nil {
		return Result{}, err
	}
	_ = s.LogStore.Trim(ctx, circleLogID) // best-effort, see server/DESIGN.md

	upload, err := s.BlobStore.GetUploadTarget(ctx, circleLogID, commit.Epoch)
	if err != nil {
		return Result{}, err
	}

	return Result{Epoch: commit.Epoch, ReceivedAt: commit.ReceivedAt, Upload: upload}, nil
}
