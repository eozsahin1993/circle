package deleteblob

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"

	"circle-relay/internal/api/auth"
	"circle-relay/internal/api/circleerrors"
	"circle-relay/internal/httputil"
)

// Credentials in the body — see getuploadtarget's handler.go for why.
// authorityPublicKey and signature are optional: the uploading account
// needs neither, and the session already says who that is.
type request struct {
	WriteToken         string `json:"writeToken"`
	AuthorityPublicKey string `json:"authorityPublicKey"`
	Signature          string `json:"signature"`
}

type Handler struct {
	Service *Service
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	syncID := r.PathValue("syncId")
	entryID := r.PathValue("entryId")
	if entryID == "" {
		httputil.WriteError(w, http.StatusBadRequest, "entryId is required")
		return
	}

	var req request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.WriteToken == "" {
		httputil.WriteError(w, http.StatusBadRequest, "writeToken is required")
		return
	}

	var signature []byte
	if req.Signature != "" {
		decoded, err := hex.DecodeString(req.Signature)
		if err != nil {
			httputil.WriteError(w, http.StatusBadRequest, "signature must be hex")
			return
		}
		signature = decoded
	}

	err := h.Service.Delete(
		r.Context(),
		syncID,
		entryID,
		req.WriteToken,
		auth.AccountID(r.Context()),
		req.AuthorityPublicKey,
		signature,
	)
	if errors.Is(err, ErrNotUploader) {
		httputil.WriteError(w, http.StatusForbidden, "only the uploader or an admin can delete this blob")
		return
	}
	if err != nil {
		status, message := circleerrors.Status(err)
		httputil.WriteError(w, status, message)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
