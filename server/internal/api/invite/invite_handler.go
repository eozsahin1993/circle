package invite

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"circle-relay/internal/httputil"
)

type putInviteRequest struct {
	// EncryptedPreview is base64-encoded ciphertext (the circle's current
	// name and a small cover-picture thumbnail, encrypted client-side with
	// HKDF(invite_code, "invite-preview") — see server/INVITE_FLOW.md).
	// This handler never looks inside it.
	EncryptedPreview string `json:"encryptedPreview"`
}

type putInviteResponse struct {
	OK bool `json:"ok"`
}

type PutInviteHandler struct {
	Service *Service
}

func (h *PutInviteHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	inviteTag := r.PathValue("inviteTag")

	var req putInviteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	encryptedPreview, err := base64.StdEncoding.DecodeString(req.EncryptedPreview)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "encryptedPreview must be base64-encoded")
		return
	}
	if len(encryptedPreview) == 0 {
		httputil.WriteError(w, http.StatusBadRequest, "encryptedPreview is required")
		return
	}

	if err := h.Service.CreateInvite(r.Context(), inviteTag, encryptedPreview); err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to create invite")
		return
	}

	httputil.WriteJSON(w, http.StatusOK, putInviteResponse{OK: true})
}

type getInviteResponse struct {
	EncryptedPreview string `json:"encryptedPreview"`
}

type GetInviteHandler struct {
	Service *Service
}

func (h *GetInviteHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	inviteTag := r.PathValue("inviteTag")

	blob, err := h.Service.GetInvite(r.Context(), inviteTag)
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to fetch invite")
		return
	}
	if blob == nil {
		httputil.WriteError(w, http.StatusNotFound, "invite not found")
		return
	}

	httputil.WriteJSON(w, http.StatusOK, getInviteResponse{
		EncryptedPreview: base64.StdEncoding.EncodeToString(blob),
	})
}
