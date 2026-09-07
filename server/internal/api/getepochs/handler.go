package getepochs

import (
	"encoding/json"
	"net/http"

	"circle-relay/internal/api/circleerrors"
	"circle-relay/internal/httputil"
)

// maxSyncIDs matches BatchGetItem's own hard per-call limit — a request
// within it never needs chunking into multiple BatchGetItem calls (only
// the UnprocessedKeys retry loop, needed regardless of count).
const maxSyncIDs = 100

// request carries the syncIds in the body rather than as repeated query
// params — a query string commonly ends up in access logs by default
// (most combined/common log formats include the full request line), and
// this is the one call that names a device's *entire* circle set at once,
// so logging it would hand a reader the whole membership list in a single
// line. Same reasoning as getuploadtarget/appendlog already putting their
// sensitive fields in the body. POST rather than GET for the same reason:
// a body on a GET is legal but widely mishandled by proxies and caches.
type request struct {
	SyncIDs []string `json:"syncIds"`
}

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
	var req request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	syncIDs := req.SyncIDs
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
