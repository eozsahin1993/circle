package getuploadtarget

import "net/http"

// Register mounts this endpoint's route onto mux — called by the final,
// aggregating router in internal/api, which decides what version prefix
// (if any) mux itself is mounted under.
func Register(mux *http.ServeMux, service *Service) {
	mux.Handle("GET /circles/{syncId}/entries/{entryId}/upload", &Handler{Service: service})
}
