package logout

import (
	"net/http"
	"strings"

	"circle-relay/internal/httputil"
)

type response struct {
	OK bool `json:"ok"`
}

type Handler struct {
	Service *Service
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	token, ok := bearerToken(r)
	if !ok {
		httputil.WriteError(w, http.StatusBadRequest, "missing bearer token")
		return
	}

	if err := h.Service.Logout(r.Context(), token); err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to log out")
		return
	}

	// Deliberately just {"ok": true} regardless of whether a session
	// actually existed for token — same non-enumeration reasoning used
	// elsewhere in this codebase, and it matches DeleteSession's own
	// idempotent semantics.
	httputil.WriteJSON(w, http.StatusOK, response{OK: true})
}

func bearerToken(r *http.Request) (string, bool) {
	const prefix = "Bearer "
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, prefix) {
		return "", false
	}
	token := strings.TrimPrefix(header, prefix)
	if token == "" {
		return "", false
	}
	return token, true
}
