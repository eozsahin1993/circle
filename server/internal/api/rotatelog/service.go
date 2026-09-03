// Package rotatelog is the whole vertical slice for POST
// /circles/{syncId}/rotate — see logstore.Store.Rotate. The one write
// path gated by both capabilities at once: the write token (proving
// current membership) and an authority signature (proving admin status),
// atomically alongside appending the key_rotation entry and swapping in
// the new write token — see server/SYNC_DESIGN.md's "Authorization"
// section.
package rotatelog

import (
	"context"

	"circle-relay/internal/storage/logstore"
)

type Service struct {
	LogStore logstore.Store
}

func (s *Service) Rotate(ctx context.Context, syncID, entryID string, encryptedPayload []byte, currentKeyVersion int64, currentWriteToken, newWriteTokenHash, authorityPublicKey string, signature []byte) (logstore.CommitResult, error) {
	return s.LogStore.Rotate(ctx, syncID, entryID, encryptedPayload, currentKeyVersion, currentWriteToken, newWriteTokenHash, authorityPublicKey, signature)
}
