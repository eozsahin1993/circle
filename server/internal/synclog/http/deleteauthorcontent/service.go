// Package deleteauthorcontent erases every content entry one identity
// authored in a circle — POST /circles/{syncId}/delete-author-content.
// Account deletion's per-circle call: with the tombstone fields it's a
// current member's erase-and-announce; without them it's a departed
// member's strip-only erase, authorized purely by the author signature.
// All verification lives in synclog.LogStore.DeleteAuthorContent; this
// package is routing, error mapping, and the blob cleanup behind it.
package deleteauthorcontent

import (
	"context"
	"log"

	"circle-relay/internal/synclog"
)

type Service struct {
	LogStore  synclog.LogStore
	BlobStore synclog.BlobStore
}

// Delete strips the entries, then best-effort deletes the blobs behind
// them — same reasoning as deleteentry's service: the strip already
// committed and is the truth clients act on, so a blob failure is
// logged, not returned.
func (s *Service) Delete(ctx context.Context, deletion synclog.AuthorContentDeletion) (synclog.AuthorContentResult, error) {
	result, err := s.LogStore.DeleteAuthorContent(ctx, deletion)
	if err != nil {
		return synclog.AuthorContentResult{}, err
	}
	if len(result.StrippedEntryIDs) > 0 {
		if err := s.BlobStore.DeleteMany(ctx, deletion.SyncID, result.StrippedEntryIDs); err != nil {
			log.Printf("author content stripped for %s, but blobs were not all removed: %v", deletion.SyncID, err)
		}
	}
	return result, nil
}
