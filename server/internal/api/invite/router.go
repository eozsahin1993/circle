package invite

import "net/http"

// Register mounts this endpoint's routes onto mux — called by the final,
// aggregating router in internal/api, which decides what version prefix
// (if any) mux itself is mounted under.
func Register(mux *http.ServeMux, service *Service) {
	mux.Handle("PUT /invites/{inviteTag}", &PutInviteHandler{Service: service})
	mux.Handle("GET /invites/{inviteTag}", &GetInviteHandler{Service: service})

	mux.Handle("PUT /invites/{inviteTag}/requests/{requesterId}", &PutRequestHandler{Service: service})
	mux.Handle("GET /invites/{inviteTag}/requests", &ListRequestsHandler{Service: service})
	mux.Handle("GET /invites/{inviteTag}/requests/{requesterId}", &GetRequestHandler{Service: service})
	mux.Handle("PUT /invites/{inviteTag}/requests/{requesterId}/approval", &PutApprovalHandler{Service: service})
}
