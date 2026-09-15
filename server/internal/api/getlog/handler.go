package getlog

import (
	"encoding/base64"
	"net/http"
	"strconv"

	"circle-relay/internal/api/circleerrors"
	"circle-relay/internal/httputil"
	"circle-relay/internal/storage/logstore"
)

type entryResponse struct {
	Epoch int64 `json:"epoch"`
	// KeyVersion is plaintext — which content key EncryptedMeta was
	// encrypted under, for direct lookup instead of trial-decryption.
	KeyVersion    int64  `json:"keyVersion"`
	EncryptedMeta string `json:"encryptedMeta"`
	ReceivedAt    int64  `json:"receivedAt"`
	// Optional deleted entries with empty EncryptedMeta
	DeletedAt int64 `json:"deletedAt,omitempty"`
}

type response struct {
	Entries []entryResponse `json:"entries"`
	// CurrentEpoch is this namespace's true latest — see
	// logstore.FetchResult.CurrentEpoch. A caller advances its own cursor
	// to the last entry it actually received, not to this value, and
	// calls again if the two don't match.
	CurrentEpoch int64 `json:"currentEpoch"`
}

type Handler struct {
	Service *Service
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	syncID := r.PathValue("syncId")

	ns := logstore.Namespace(r.URL.Query().Get("namespace"))
	if !ns.Valid() {
		httputil.WriteError(w, http.StatusBadRequest, "namespace must be \"meta\" or \"content\"")
		return
	}

	// An epoch: a position in this namespace's sequence, not a timestamp.
	// Entries carry their own receivedAt for that.
	sinceEpoch := int64(0)
	if raw := r.URL.Query().Get("sinceEpoch"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			httputil.WriteError(w, http.StatusBadRequest, "sinceEpoch must be an integer")
			return
		}
		sinceEpoch = parsed
	}

	result, err := h.Service.Fetch(r.Context(), syncID, ns, sinceEpoch)
	if err != nil {
		status, message := circleerrors.Status(err)
		httputil.WriteError(w, status, message)
		return
	}

	entries := make([]entryResponse, len(result.Entries))
	for i, e := range result.Entries {
		entries[i] = entryResponse{
			Epoch:         e.Epoch,
			KeyVersion:    e.KeyVersion,
			EncryptedMeta: base64.StdEncoding.EncodeToString(e.EncryptedMeta),
			ReceivedAt:    e.ReceivedAt,
			DeletedAt:     e.DeletedAt,
		}
	}

	httputil.WriteJSON(w, http.StatusOK, response{Entries: entries, CurrentEpoch: result.CurrentEpoch})
}
