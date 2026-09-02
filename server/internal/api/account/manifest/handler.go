package manifest

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"circle-relay/internal/api/auth"
	"circle-relay/internal/httputil"
)

type getResponse struct {
	// Blob is null until this account has ever stored a manifest.
	Blob *string `json:"blob"`
}

type GetHandler struct {
	Service *Service
}

func (h *GetHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	blob, err := h.Service.Get(r.Context(), auth.AccountID(r.Context()))
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to fetch manifest")
		return
	}
	if blob == nil {
		httputil.WriteJSON(w, http.StatusOK, getResponse{})
		return
	}
	encoded := base64.StdEncoding.EncodeToString(blob)
	httputil.WriteJSON(w, http.StatusOK, getResponse{Blob: &encoded})
}

type putRequest struct {
	// Blob is base64-encoded ciphertext — this handler never looks inside it.
	Blob string `json:"blob"`
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

	if err := h.Service.Put(r.Context(), auth.AccountID(r.Context()), blob); err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to save manifest")
		return
	}

	httputil.WriteJSON(w, http.StatusOK, putResponse{OK: true})
}
