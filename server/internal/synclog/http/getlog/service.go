// Package getlog is the whole vertical slice for GET
// /circles/{syncId}/entries.
package getlog

import (
	"context"

	"mimoza-relay/internal/synclog"
)

type Service struct {
	LogStore synclog.LogStore
}

func (s *Service) Fetch(ctx context.Context, syncID string, ns synclog.Namespace, sinceEpoch int64) (synclog.FetchResult, error) {
	return s.LogStore.Read(ctx, syncID, ns, sinceEpoch)
}
