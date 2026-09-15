package deleteblob

import "net/http"

// Register mounts this endpoint's route onto mux — see getuploadtarget's
// router.go for what wrap is for.
func Register(mux *http.ServeMux, service *Service, wrap func(http.Handler) http.Handler) {
	var h http.Handler = &Handler{Service: service}
	if wrap != nil {
		h = wrap(h)
	}
	mux.Handle("POST /circles/{syncId}/entries/{entryId}/delete-blob", h)
}
