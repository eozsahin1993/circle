// Package deletecircle is the whole vertical slice for POST
// /circles/{syncId}/delete — see logstore.Store.DeleteCircle. Ends a
// circle: the tombstone recording it goes down first, then everything the
// circle owned is swept away beneath it.
//
// Gated by both capabilities, like rotatelog and changeauthority: the
// write token and an authority signature. Nothing here checks that the
// caller is the last member — the roster is ciphertext to the relay. That
// judgement is the client's; the signature only bounds who may make it.
package deletecircle

import (
	"context"
	"fmt"

	"circle-relay/internal/storage/blobstore"
	"circle-relay/internal/storage/logstore"
)

type Service struct {
	LogStore  logstore.Store
	BlobStore blobstore.Store
}

// DeleteCircle sweeps blobs only once the log side has succeeded: blobs
// destroyed without a tombstone would leave members with photos they
// can't fetch and no entry explaining why. Idempotent, so a failure part
// way through is fixed by calling again.
//
// A blob sweep that fails after the tombstone committed is reported, but
// the circle is deleted either way — clients act on the entry, not on
// this response.
func (s *Service) DeleteCircle(ctx context.Context, deletion logstore.CircleDeletion) (logstore.CommitResult, error) {
	result, err := s.LogStore.DeleteCircle(ctx, deletion)
	if err != nil {
		return logstore.CommitResult{}, err
	}
	if err := s.BlobStore.DeleteCircle(ctx, deletion.SyncID); err != nil {
		return result, fmt.Errorf("circle %s deleted, but its blobs were not fully removed: %w", deletion.SyncID, err)
	}
	return result, nil
}
