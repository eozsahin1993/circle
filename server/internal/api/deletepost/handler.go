package deletepost

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"

	"circle-relay/internal/api/circleerrors"
	"circle-relay/internal/httputil"
	"circle-relay/internal/storage/logstore"
)

// AuthorSignature and AuthorityPublicKey/AuthoritySignature are both
// optional and independent, same shape as deleteblob's request — the
// post's own author sends AuthorSignature and needs nothing else; an
// admin deleting someone else's post sends the authority pair instead.
type request struct {
	WriteToken       string `json:"writeToken"`
	TombstoneEntryID string `json:"tombstoneEntryId"`
	EncryptedMeta    string `json:"encryptedMeta"`
	KeyVersion       int64  `json:"keyVersion"`
	AuthorSignature  string `json:"authorSignature"`

	// Optional if admin deleted the post instead of the author
	AuthorityPublicKey string `json:"authorityPublicKey"`
	AuthoritySignature string `json:"authoritySignature"`
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
	postEntryID := r.PathValue("entryId")
	if postEntryID == "" {
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
	if req.TombstoneEntryID == "" {
		httputil.WriteError(w, http.StatusBadRequest, "tombstoneEntryId is required")
		return
	}
	if req.KeyVersion <= 0 {
		httputil.WriteError(w, http.StatusBadRequest, "keyVersion must be a positive integer")
		return
	}

	encryptedMeta, err := base64.StdEncoding.DecodeString(req.EncryptedMeta)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "encryptedMeta must be base64-encoded")
		return
	}
	var authorSignature []byte
	if req.AuthorSignature != "" {
		decoded, err := hex.DecodeString(req.AuthorSignature)
		if err != nil {
			httputil.WriteError(w, http.StatusBadRequest, "authorSignature must be hex")
			return
		}
		authorSignature = decoded
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

	result, err := h.Service.Delete(r.Context(), logstore.PostDeletion{
		SyncID:             syncID,
		PostEntryID:        postEntryID,
		TombstoneEntryID:   req.TombstoneEntryID,
		EncryptedPayload:   encryptedMeta,
		KeyVersion:         req.KeyVersion,
		WriteToken:         req.WriteToken,
		AuthorSignature:    authorSignature,
		AuthorityPublicKey: req.AuthorityPublicKey,
		AuthoritySignature: authoritySignature,
	})
	if err != nil {
		status, message := circleerrors.Status(err)
		httputil.WriteError(w, status, message)
		return
	}

	httputil.WriteJSON(w, http.StatusOK, response{Epoch: result.Epoch, ReceivedAt: result.ReceivedAt})
}
