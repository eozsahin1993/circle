package appendentry

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"circle-relay/internal/httputil"
)

type request struct {
	EntryID string `json:"entryId"`
	// EncryptedMeta is base64-encoded ciphertext — see server/DESIGN.md's
	// encryption envelope. This handler never looks inside it.
	EncryptedMeta string `json:"encryptedMeta"`
}

type response struct {
	Epoch      int64  `json:"epoch"`
	ReceivedAt int64  `json:"receivedAt"`
	UploadURL  string `json:"uploadUrl"`
}

type Handler struct {
	Service *Service
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	circleLogID := r.PathValue("circleLogId")

	var req request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.EntryID == "" {
		httputil.WriteError(w, http.StatusBadRequest, "entryId is required")
		return
	}

	encryptedMeta, err := base64.StdEncoding.DecodeString(req.EncryptedMeta)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "encryptedMeta must be base64-encoded")
		return
	}

	result, err := h.Service.Append(r.Context(), circleLogID, req.EntryID, encryptedMeta)
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to append entry")
		return
	}

	httputil.WriteJSON(w, http.StatusOK, response{
		Epoch:      result.Epoch,
		ReceivedAt: result.ReceivedAt,
		UploadURL:  result.UploadURL,
	})
}
