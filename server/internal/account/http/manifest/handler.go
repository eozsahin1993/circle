package manifest

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"

	"circle-relay/internal/account"
	"circle-relay/internal/auth"
	"circle-relay/internal/httputil"
)

type getResponse struct {
	// Blob is null until this account has ever stored a manifest.
	Blob *string `json:"blob"`
	// Version to quote back on the next write. 0 both for "never stored"
	// and for a manifest written before versioning existed.
	Version int64 `json:"version"`
}

type GetHandler struct {
	Service *Service
}

func (h *GetHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	stored, err := h.Service.Get(r.Context(), auth.AccountID(r.Context()))
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to fetch manifest")
		return
	}
	if stored.Blob == nil {
		httputil.WriteJSON(w, http.StatusOK, getResponse{})
		return
	}
	encoded := base64.StdEncoding.EncodeToString(stored.Blob)
	httputil.WriteJSON(w, http.StatusOK, getResponse{Blob: &encoded, Version: stored.Version})
}

type putRequest struct {
	// Blob is base64-encoded ciphertext — this handler never looks inside it.
	Blob string `json:"blob"`
	// ExpectedVersion is the version the client last read. Omitted reads as
	// 0, which is also what a first write against a never-stored or
	// pre-versioning manifest sends.
	ExpectedVersion int64 `json:"expectedVersion"`
}

type putResponse struct {
	OK bool `json:"ok"`
}

type PutHandler struct {
	Service *Service
}

func (h *PutHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req putRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	blob, err := base64.StdEncoding.DecodeString(req.Blob)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "blob must be base64-encoded")
		return
	}
	if len(blob) == 0 {
		httputil.WriteError(w, http.StatusBadRequest, "blob is required")
		return
	}

	err = h.Service.Put(r.Context(), auth.AccountID(r.Context()), blob, req.ExpectedVersion)
	if errors.Is(err, account.ErrVersionMismatch) {
		// Another of this account's devices wrote first. The client has to
		// re-read and reapply — it can't just retry the same blob, which
		// would drop whatever that device recorded.
		httputil.WriteError(w, http.StatusConflict, "manifest changed since it was read")
		return
	}
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to save manifest")
		return
	}

	httputil.WriteJSON(w, http.StatusOK, putResponse{OK: true})
}
