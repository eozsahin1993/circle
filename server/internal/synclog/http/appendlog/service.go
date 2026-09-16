// Package appendlog is the vertical slice for POST
// /circles/{syncId}/entries. Deliberately doesn't touch synclog.BlobStore —
// meta-namespace entries never have a blob, so unconditionally vending an
// upload target here (as the pre-redesign version did) no longer makes
// sense; see getuploadtarget for that concern.
package appendlog

import (
	"context"

	"mimoza-relay/internal/synclog"
)

type Service struct {
	Log *synclog.Service
}

// Append is the possession-gated write path — see
// synclog.LogStore.Append's doc comment for the write-token check and
// idempotency guarantee this passes straight through.
func (s *Service) Append(ctx context.Context, syncID string, ns synclog.Namespace, entryID string, encryptedPayload []byte, keyVersion int64, writeToken, authorIdentityPublicKey string) (synclog.CommitResult, error) {
	return s.Log.Append(ctx, syncID, ns, entryID, encryptedPayload, keyVersion, writeToken, authorIdentityPublicKey)
}
