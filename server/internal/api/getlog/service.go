// Package getlog is the whole vertical slice for GET
// /circles/{syncId}/entries.
package getlog

import (
	"context"

	"circle-relay/internal/storage/logstore"
)

type Service struct {
	LogStore logstore.Store
}

func (s *Service) Fetch(ctx context.Context, syncID string, ns logstore.Namespace, since int64) (logstore.FetchResult, error) {
	return s.LogStore.Read(ctx, syncID, ns, since)
}
