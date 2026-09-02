package invite

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"

	"circle-relay/internal/httputil"
	"circle-relay/internal/storage/invitestore"
)

// requestResponse is the wire shape for one join-request row —
// EncryptedApproval is null until the invite's creator approves it.
type requestResponse struct {
	RequesterID       string  `json:"requesterId"`
	EncryptedRequest  string  `json:"encryptedRequest"`
	EncryptedApproval *string `json:"encryptedApproval"`
	CreatedAt         int64   `json:"createdAt"`
}

func toRequestResponse(jr invitestore.JoinRequest) requestResponse {
	resp := requestResponse{
		RequesterID:      jr.RequesterID,
		EncryptedRequest: base64.StdEncoding.EncodeToString(jr.EncryptedRequest),
		CreatedAt:        jr.CreatedAt,
	}
	if jr.EncryptedApproval != nil {
		encoded := base64.StdEncoding.EncodeToString(jr.EncryptedApproval)
		resp.EncryptedApproval = &encoded
	}
	return resp
}

type putRequestRequest struct {
	// EncryptedRequest is base64-encoded ciphertext ({ephemeralPub,
	// selfReportedName}, encrypted client-side with HKDF(invite_code,
	// "join-request") — see server/INVITE_FLOW.md). This handler never
	// looks inside it.
	EncryptedRequest string `json:"encryptedRequest"`
}

type putRequestResponse struct {
	OK bool `json:"ok"`
}

type PutRequestHandler struct {
	Service *Service
}

func (h *PutRequestHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	inviteTag := r.PathValue("inviteTag")
	requesterID := r.PathValue("requesterId")

	var req putRequestRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	encryptedRequest, err := base64.StdEncoding.DecodeString(req.EncryptedRequest)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "encryptedRequest must be base64-encoded")
		return
	}
	if len(encryptedRequest) == 0 {
		httputil.WriteError(w, http.StatusBadRequest, "encryptedRequest is required")
		return
	}

	if err := h.Service.PutRequest(r.Context(), inviteTag, requesterID, encryptedRequest); err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to save join request")
		return
	}

	httputil.WriteJSON(w, http.StatusOK, putRequestResponse{OK: true})
}

type listRequestsResponse struct {
	Requests []requestResponse `json:"requests"`
}

type ListRequestsHandler struct {
	Service *Service
}

func (h *ListRequestsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	inviteTag := r.PathValue("inviteTag")

	requests, err := h.Service.ListRequests(r.Context(), inviteTag)
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to list join requests")
		return
	}

	responses := make([]requestResponse, len(requests))
	for i, jr := range requests {
		responses[i] = toRequestResponse(jr)
	}

	httputil.WriteJSON(w, http.StatusOK, listRequestsResponse{Requests: responses})
}

type GetRequestHandler struct {
	Service *Service
}

func (h *GetRequestHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	inviteTag := r.PathValue("inviteTag")
	requesterID := r.PathValue("requesterId")

	jr, err := h.Service.GetRequest(r.Context(), inviteTag, requesterID)
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to fetch join request")
		return
	}
	if jr == nil {
		httputil.WriteError(w, http.StatusNotFound, "join request not found")
		return
	}

	httputil.WriteJSON(w, http.StatusOK, toRequestResponse(*jr))
}

type putApprovalRequest struct {
	// EncryptedApproval is base64-encoded ciphertext (the sealed-box
	// {secret, circleName} payload, encrypted to the requester's
	// ephemeralPub — see server/INVITE_FLOW.md). This handler never looks
	// inside it.
	EncryptedApproval string `json:"encryptedApproval"`
}

type putApprovalResponse struct {
	OK bool `json:"ok"`
}

type PutApprovalHandler struct {
	Service *Service
}

func (h *PutApprovalHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	inviteTag := r.PathValue("inviteTag")
	requesterID := r.PathValue("requesterId")

	var req putApprovalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	encryptedApproval, err := base64.StdEncoding.DecodeString(req.EncryptedApproval)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "encryptedApproval must be base64-encoded")
		return
	}
	if len(encryptedApproval) == 0 {
		httputil.WriteError(w, http.StatusBadRequest, "encryptedApproval is required")
		return
	}

	if err := h.Service.PutApproval(r.Context(), inviteTag, requesterID, encryptedApproval); err != nil {
		if errors.Is(err, invitestore.ErrJoinRequestNotFound) {
			httputil.WriteError(w, http.StatusNotFound, "join request not found")
			return
		}
		httputil.WriteError(w, http.StatusInternalServerError, "failed to save approval")
		return
	}

	httputil.WriteJSON(w, http.StatusOK, putApprovalResponse{OK: true})
}
