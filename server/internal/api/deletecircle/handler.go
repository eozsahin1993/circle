package deletecircle

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"

	"circle-relay/internal/api/circleerrors"
	"circle-relay/internal/httputil"
	"circle-relay/internal/storage/logstore"
)

type request struct {
	EntryID string `json:"entryId"`
	// EncryptedMeta is base64-encoded ciphertext — the circle_deleted entry's payload. Opaque to this handler.
	EncryptedMeta string `json:"encryptedMeta"`
	KeyVersion    int64  `json:"keyVersion"`
	// WriteToken: raw hex, proves current membership.
	WriteToken string `json:"writeToken"`
	// SignerAuthorityPublicKey: hex ed25519 key Signature was produced with, checked against the authority set.
	SignerAuthorityPublicKey string `json:"signerAuthorityPublicKey"`
	// Signature: hex, over logstore.CircleDeletion.Message().
	Signature string `json:"signature"`
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
	for field, value := range map[string]string{
		"entryId":                  req.EntryID,
		"writeToken":               req.WriteToken,
		"signerAuthorityPublicKey": req.SignerAuthorityPublicKey,
		"signature":                req.Signature,
	} {
		if value == "" {
			httputil.WriteError(w, http.StatusBadRequest, field+" is required")
			return
		}
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
	signature, err := hex.DecodeString(req.Signature)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "signature must be hex-encoded")
		return
	}

	result, err := h.Service.DeleteCircle(r.Context(), logstore.CircleDeletion{
		SyncID:                   syncID,
		EntryID:                  req.EntryID,
		EncryptedPayload:         encryptedMeta,
		KeyVersion:               req.KeyVersion,
		WriteToken:               req.WriteToken,
		SignerAuthorityPublicKey: req.SignerAuthorityPublicKey,
		Signature:                signature,
	})
	if err != nil {
		status, message := circleerrors.Status(err)
		httputil.WriteError(w, status, message)
		return
	}

	httputil.WriteJSON(w, http.StatusOK, response{Epoch: result.Epoch, ReceivedAt: result.ReceivedAt})
}
