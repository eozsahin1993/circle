package createlog

import (
	"encoding/json"
	"net/http"

	"circle-relay/internal/api/circleerrors"
	"circle-relay/internal/httputil"
)

type request struct {
	FounderAuthorityPublicKey string `json:"founderAuthorityPublicKey"`
	InitialWriteTokenHash     string `json:"initialWriteTokenHash"`
}

type Handler struct {
	Service *Service
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	syncID := r.PathValue("syncId")
	if syncID == "" {
		httputil.WriteError(w, http.StatusBadRequest, "syncId is required")
		return
	}

	var req request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.FounderAuthorityPublicKey == "" {
		httputil.WriteError(w, http.StatusBadRequest, "founderAuthorityPublicKey is required")
		return
	}
	if req.InitialWriteTokenHash == "" {
		httputil.WriteError(w, http.StatusBadRequest, "initialWriteTokenHash is required")
		return
	}

	if err := h.Service.Bootstrap(r.Context(), syncID, req.FounderAuthorityPublicKey, req.InitialWriteTokenHash); err != nil {
		status, message := circleerrors.Status(err)
		httputil.WriteError(w, status, message)
		return
	}

	w.WriteHeader(http.StatusCreated)
}
