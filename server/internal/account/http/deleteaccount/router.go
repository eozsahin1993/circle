package deleteaccount

import "net/http"

// Register mounts this endpoint's route onto mux — called by the final,
// aggregating router in internal/api, which decides what version prefix
// (if any) mux itself is mounted under.
//
// The exact "/account" pattern (no trailing slash) can't live inside the
// "/account/" subtree sub-mux — ServeMux answers the bare path there with
// a redirect, which DELETE callers won't follow — so this registers on
// the parent mux and wraps its own session check via wrap.
func Register(mux *http.ServeMux, service *Service, wrap func(http.Handler) http.Handler) {
	var h http.Handler = &Handler{Service: service}
	if wrap != nil {
		h = wrap(h)
	}
	mux.Handle("DELETE /account", h)
}
