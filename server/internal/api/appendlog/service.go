// Package appendlog is the vertical slice for POST
// /circles/{syncId}/entries. Deliberately doesn't touch blobstore.Store —
// meta-namespace entries never have a blob, so unconditionally vending an
// upload target here (as the pre-redesign version did) no longer makes
// sense; see getuploadtarget for that concern.
package appendlog

import (
	"context"

	"circle-relay/internal/storage/logstore"
)

type Service struct {
	LogStore logstore.Store
}

// Append is the possession-gated write path — see
// logstore.Store.Append's doc comment for the write-token check and
// idempotency guarantee this passes straight through.
func (s *Service) Append(ctx context.Context, syncID string, ns logstore.Namespace, entryID string, encryptedPayload []byte, keyVersion int64, writeToken string) (logstore.CommitResult, error) {
	return s.LogStore.Append(ctx, syncID, ns, entryID, encryptedPayload, keyVersion, writeToken)
}
