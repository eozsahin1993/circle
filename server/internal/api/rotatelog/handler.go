package rotatelog

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"

	"circle-relay/internal/api/circleerrors"
	"circle-relay/internal/httputil"
)

type request struct {
	EntryID string `json:"entryId"`
	// EncryptedMeta is base64-encoded ciphertext — the key_rotation entry's payload. Opaque to this handler.
	EncryptedMeta string `json:"encryptedMeta"`
	// CurrentKeyVersion: always the *pre*-rotation version — see logstore.Store.Rotate.
	CurrentKeyVersion int64 `json:"currentKeyVersion"`
	// CurrentWriteToken: raw hex, proves membership as of the key being rotated away from.
	CurrentWriteToken string `json:"currentWriteToken"`
	// NewWriteTokenHash: hex sha256 — the relay only ever sees the hash, never the token or key.
	NewWriteTokenHash string `json:"newWriteTokenHash"`
	// AuthorityPublicKey: hex ed25519 key Signature was produced with, checked against the authority set.
	AuthorityPublicKey string `json:"authorityPublicKey"`
	// Signature: hex, over logstore.RotateMessage(syncId, entryId, newWriteTokenHash).
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
		"entryId":            req.EntryID,
		"currentWriteToken":  req.CurrentWriteToken,
		"newWriteTokenHash":  req.NewWriteTokenHash,
		"authorityPublicKey": req.AuthorityPublicKey,
		"signature":          req.Signature,
	} {
		if value == "" {
			httputil.WriteError(w, http.StatusBadRequest, field+" is required")
			return
		}
	}
	if req.CurrentKeyVersion <= 0 {
		httputil.WriteError(w, http.StatusBadRequest, "currentKeyVersion must be a positive integer")
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

	result, err := h.Service.Rotate(r.Context(), syncID, req.EntryID, encryptedMeta, req.CurrentKeyVersion, req.CurrentWriteToken, req.NewWriteTokenHash, req.AuthorityPublicKey, signature)
	if err != nil {
		status, message := circleerrors.Status(err)
		httputil.WriteError(w, status, message)
		return
	}

	httputil.WriteJSON(w, http.StatusOK, response{Epoch: result.Epoch, ReceivedAt: result.ReceivedAt})
}
