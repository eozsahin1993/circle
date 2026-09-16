// Package deleteentry strips one content entry's ciphertext and appends its
// tombstone — POST /circles/{syncId}/entries/{entryId}/delete-entry
// (POST for the same reason as deleteblob: credentials belong in a body).
//
// Unlike deleteblob, the row itself isn't removed — comments/reactions
// reference it by id, and removing it would break their replay for
// everyone, not just erase the deleter's own content. All the lookup and
// author-or-admin verification lives in synclog.Service.DeleteEntry; this
// package is routing and error mapping only.
package deleteentry

import (
	"context"
	"log"

	"circle-relay/internal/synclog"
)

type Service struct {
	Log       *synclog.Service
	BlobStore synclog.BlobStore
}

// Delete strips the post's log entry, then best-effort deletes its blob —
// unconditionally: S3's DeleteObject is idempotent, so a post that never
// had one (a failed upload) costs one harmless no-op call, no existence
// check needed first. A blob-delete failure is logged, not returned: the
// tombstone already committed and is the truth clients act on, the same
// reasoning deleteBlobFor uses client-side for this exact cleanup.
func (s *Service) Delete(ctx context.Context, deletion synclog.EntryDeletion) (synclog.CommitResult, error) {
	result, err := s.Log.DeleteEntry(ctx, deletion)
	if err != nil {
		return synclog.CommitResult{}, err
	}
	if err := s.BlobStore.Delete(ctx, deletion.SyncID, deletion.TargetEntryID); err != nil {
		log.Printf("post %s deleted, but its blob was not removed: %v", deletion.TargetEntryID, err)
	}
	return result, nil
}
