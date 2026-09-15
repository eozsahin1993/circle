package manifest

import "net/http"

// Register mounts this endpoint's routes onto mux — called by the final,
// aggregating router in internal/api, which decides what version prefix
// (if any) mux itself is mounted under.
func Register(mux *http.ServeMux, service *Service) {
	mux.Handle("GET /account/manifest", &GetHandler{Service: service})
	mux.Handle("PUT /account/manifest", &PutHandler{Service: service})
}
