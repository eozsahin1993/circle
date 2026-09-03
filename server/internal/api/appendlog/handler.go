package appendlog

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"circle-relay/internal/api/circleerrors"
	"circle-relay/internal/httputil"
	"circle-relay/internal/storage/logstore"
)

type request struct {
	Namespace string `json:"namespace"`
	EntryID   string `json:"entryId"`
	// EncryptedMeta is base64-encoded ciphertext — opaque to this handler, including its entry type.
	EncryptedMeta string `json:"encryptedMeta"`
	// KeyVersion is plaintext — which content key encryptedMeta was encrypted under. Stored as-is, never verified (can't be — opaque).
	KeyVersion int64 `json:"keyVersion"`
	// WriteToken is the raw (not pre-hashed) hex-encoded token — see logstore.Store.Append.
	WriteToken string `json:"writeToken"`
}

type response struct {
	Epoch      int64 `json:"epoch"`
	ReceivedAt int64 `json:"receivedAt"`
}

type Handler struct {
	Service *Service
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	syncID := r.PathValue("syncId")

	var req request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	ns := logstore.Namespace(req.Namespace)
	if !ns.Valid() {
		httputil.WriteError(w, http.StatusBadRequest, "namespace must be \"meta\" or \"content\"")
		return
	}
	if req.EntryID == "" {
		httputil.WriteError(w, http.StatusBadRequest, "entryId is required")
		return
	}
	if req.KeyVersion <= 0 {
		httputil.WriteError(w, http.StatusBadRequest, "keyVersion must be a positive integer")
		return
	}
	if req.WriteToken == "" {
		httputil.WriteError(w, http.StatusBadRequest, "writeToken is required")
		return
	}

	encryptedMeta, err := base64.StdEncoding.DecodeString(req.EncryptedMeta)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "encryptedMeta must be base64-encoded")
		return
	}

	result, err := h.Service.Append(r.Context(), syncID, ns, req.EntryID, encryptedMeta, req.KeyVersion, req.WriteToken)
	if err != nil {
		status, message := circleerrors.Status(err)
		httputil.WriteError(w, status, message)
		return
	}

	httputil.WriteJSON(w, http.StatusOK, response{Epoch: result.Epoch, ReceivedAt: result.ReceivedAt})
}
