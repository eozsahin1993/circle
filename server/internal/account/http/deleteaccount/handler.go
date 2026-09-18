package deleteaccount

import (
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/util/httputil"
)

type response struct {
	OK bool `json:"ok"`
}

type Handler struct {
	Service *Service
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if err := h.Service.Delete(r.Context(), auth.AccountID(r.Context())); err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to delete account")
		return
	}
	httputil.WriteJSON(w, http.StatusOK, response{OK: true})
}
