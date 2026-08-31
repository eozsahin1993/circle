package fetchentries

import (
	"encoding/base64"
	"net/http"
	"strconv"

	"circle-relay/internal/httputil"
)

type entryResponse struct {
	Epoch         int64  `json:"epoch"`
	EncryptedMeta string `json:"encryptedMeta"`
	ReceivedAt    int64  `json:"receivedAt"`
}

type response struct {
	Entries              []entryResponse `json:"entries"`
	LatestEpoch          int64           `json:"latestEpoch"`
	OldestAvailableEpoch int64           `json:"oldestAvailableEpoch"`
}

type Handler struct {
	Service *Service
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	circleLogID := r.PathValue("circleLogId")

	since := int64(0)
	if raw := r.URL.Query().Get("since"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			httputil.WriteError(w, http.StatusBadRequest, "since must be an integer")
			return
		}
		since = parsed
	}

	result, err := h.Service.Fetch(r.Context(), circleLogID, since)
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to fetch entries")
		return
	}

	entries := make([]entryResponse, len(result.Entries))
	for i, e := range result.Entries {
		entries[i] = entryResponse{
			Epoch:         e.Epoch,
			EncryptedMeta: base64.StdEncoding.EncodeToString(e.EncryptedMeta),
			ReceivedAt:    e.ReceivedAt,
		}
	}

	httputil.WriteJSON(w, http.StatusOK, response{
		Entries:              entries,
		LatestEpoch:          result.LatestEpoch,
		OldestAvailableEpoch: result.OldestAvailableEpoch,
	})
}
