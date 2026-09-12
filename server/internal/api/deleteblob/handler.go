package deleteblob

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"

	"circle-relay/internal/api/circleerrors"
	"circle-relay/internal/httputil"
)

// Credentials in the body — see getuploadtarget's handler.go for why.
// Both signatures are optional and independent: the original uploader
// sends uploaderSignature and needs nothing else; anyone deleting someone
// else's blob needs authorityPublicKey + authoritySignature instead.
type request struct {
	WriteToken         string `json:"writeToken"`
	UploaderSignature  string `json:"uploaderSignature"`
	AuthorityPublicKey string `json:"authorityPublicKey"`
	AuthoritySignature string `json:"authoritySignature"`
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

	var authoritySignature []byte
	if req.AuthoritySignature != "" {
		decoded, err := hex.DecodeString(req.AuthoritySignature)
		if err != nil {
			httputil.WriteError(w, http.StatusBadRequest, "authoritySignature must be hex")
			return
		}
		authoritySignature = decoded
	}

	err := h.Service.Delete(
		r.Context(),
		syncID,
		entryID,
		req.WriteToken,
		req.UploaderSignature,
		req.AuthorityPublicKey,
		authoritySignature,
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
