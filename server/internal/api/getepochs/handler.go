package getepochs

import (
	"net/http"

	"circle-relay/internal/api/circleerrors"
	"circle-relay/internal/httputil"
)

// maxSyncIDs matches BatchGetItem's own hard per-call limit — a request
// within it never needs chunking into multiple BatchGetItem calls (only
// the UnprocessedKeys retry loop, needed regardless of count).
const maxSyncIDs = 100

type circleEpochs struct {
	SyncID       string `json:"syncId"`
	MetaEpoch    int64  `json:"metaEpoch"`
	ContentEpoch int64  `json:"contentEpoch"`
}

type response struct {
	Circles []circleEpochs `json:"circles"`
}

type Handler struct {
	Service *Service
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	syncIDs := r.URL.Query()["syncId"]
	if len(syncIDs) == 0 {
		httputil.WriteError(w, http.StatusBadRequest, "at least one syncId is required")
		return
	}
	if len(syncIDs) > maxSyncIDs {
		httputil.WriteError(w, http.StatusBadRequest, "too many syncIds — at most 100 per call")
		return
	}

	epochsBySyncID, err := h.Service.Peek(r.Context(), syncIDs)
	if err != nil {
		status, message := circleerrors.Status(err)
		httputil.WriteError(w, status, message)
		return
	}

	// A requested syncId with no control state is simply omitted, not an
	// error — see logstore.Store.Peek's doc comment.
	circles := make([]circleEpochs, 0, len(epochsBySyncID))
	for _, syncID := range syncIDs {
		epochs, ok := epochsBySyncID[syncID]
		if !ok {
			continue
		}
		circles = append(circles, circleEpochs{SyncID: syncID, MetaEpoch: epochs.Meta, ContentEpoch: epochs.Content})
	}

	httputil.WriteJSON(w, http.StatusOK, response{Circles: circles})
}
