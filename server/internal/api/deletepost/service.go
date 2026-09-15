// Package deletepost strips one post's ciphertext and appends its
// tombstone — POST /circles/{syncId}/entries/{entryId}/delete-post
// (POST for the same reason as deleteblob: credentials belong in a body).
//
// Unlike deleteblob, the row itself isn't removed — comments/reactions
// reference it by id, and removing it would break their replay for
// everyone, not just erase the deleter's own content. All the lookup and
// author-or-admin verification lives in logstore.Store.DeletePost; this
// package is routing and error mapping only.
package deletepost

import (
	"context"
	"log"

	"circle-relay/internal/storage/blobstore"
	"circle-relay/internal/storage/logstore"
)

type Service struct {
	LogStore  logstore.Store
	BlobStore blobstore.Store
}

// Delete strips the post's log entry, then best-effort deletes its blob —
// unconditionally: S3's DeleteObject is idempotent, so a post that never
// had one (a failed upload) costs one harmless no-op call, no existence
// check needed first. A blob-delete failure is logged, not returned: the
// tombstone already committed and is the truth clients act on, the same
// reasoning deleteBlobFor uses client-side for this exact cleanup.
func (s *Service) Delete(ctx context.Context, deletion logstore.PostDeletion) (logstore.CommitResult, error) {
	result, err := s.LogStore.DeletePost(ctx, deletion)
	if err != nil {
		return logstore.CommitResult{}, err
	}
	if err := s.BlobStore.Delete(ctx, deletion.SyncID, deletion.PostEntryID); err != nil {
		log.Printf("post %s deleted, but its blob was not removed: %v", deletion.PostEntryID, err)
	}
	return result, nil
}
