package deleteauthorcontent

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"

	"circle-relay/internal/synclog"
	"circle-relay/internal/synclog/http/circleerrors"
	"circle-relay/internal/util/httputil"
)

// The tombstone fields travel together: TombstoneEntryID present means a
// current member erasing and announcing (EncryptedMeta, KeyVersion and
// WriteToken all required); absent means a departed member's strip-only
// erase, where only the author signature authorizes.
type request struct {
	AuthorIdentityPublicKey string `json:"authorIdentityPublicKey"`
	AuthorSignature         string `json:"authorSignature"`

	// Optional deletion announcement tombstone. This is not possible for circles
	// that you no longer have access to.
	TombstoneEntryID string `json:"tombstoneEntryId"`
	EncryptedMeta    string `json:"encryptedMeta"`
	KeyVersion       int64  `json:"keyVersion"`
	WriteToken       string `json:"writeToken"`
}

type response struct {
	StrippedCount int   `json:"strippedCount"`
	Epoch         int64 `json:"epoch,omitempty"`
	ReceivedAt    int64 `json:"receivedAt,omitempty"`
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
	if req.AuthorIdentityPublicKey == "" {
		httputil.WriteError(w, http.StatusBadRequest, "authorIdentityPublicKey is required")
		return
	}
	authorSignature, err := hex.DecodeString(req.AuthorSignature)
	if err != nil || len(authorSignature) == 0 {
		httputil.WriteError(w, http.StatusBadRequest, "authorSignature must be non-empty hex")
		return
	}

	var encryptedMeta []byte
	if req.TombstoneEntryID != "" {
		if req.WriteToken == "" {
			httputil.WriteError(w, http.StatusBadRequest, "writeToken is required with a tombstone")
			return
		}
		if req.KeyVersion <= 0 {
			httputil.WriteError(w, http.StatusBadRequest, "keyVersion must be a positive integer")
			return
		}
		encryptedMeta, err = base64.StdEncoding.DecodeString(req.EncryptedMeta)
		if err != nil {
			httputil.WriteError(w, http.StatusBadRequest, "encryptedMeta must be base64-encoded")
			return
		}
	} else if req.WriteToken != "" || req.EncryptedMeta != "" || req.KeyVersion != 0 {
		httputil.WriteError(w, http.StatusBadRequest, "tombstone fields require tombstoneEntryId")
		return
	}

	result, err := h.Service.Delete(r.Context(), synclog.AuthorContentDeletion{
		SyncID:                  syncID,
		AuthorIdentityPublicKey: req.AuthorIdentityPublicKey,
		TombstoneEntryID:        req.TombstoneEntryID,
		EncryptedPayload:        encryptedMeta,
		KeyVersion:              req.KeyVersion,
		WriteToken:              req.WriteToken,
		AuthorSignature:         authorSignature,
	})
	if err != nil {
		status, message := circleerrors.Status(err)
		httputil.WriteError(w, status, message)
		return
	}

	httputil.WriteJSON(w, http.StatusOK, response{
		StrippedCount: len(result.StrippedEntryIDs),
		Epoch:         result.Epoch,
		ReceivedAt:    result.ReceivedAt,
	})
}
