package apple

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"mimoza-relay/internal/auth/oidcverify"
	"mimoza-relay/internal/util/httputil"
)

type request struct {
	IDToken string `json:"idToken"`
}

type response struct {
	Token string `json:"token"`
}

type Handler struct {
	Service *Service
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.IDToken == "" {
		httputil.WriteError(w, http.StatusBadRequest, "idToken is required")
		return
	}

	token, err := h.Service.SignIn(r.Context(), req.IDToken)
	if err != nil {
		slog.WarnContext(r.Context(), "sign-in failed",
			"provider", "apple",
			"reason", oidcverify.Reason(err),
			"error", err)
		httputil.WriteError(w, http.StatusUnauthorized, "invalid Apple sign-in")
		return
	}

	httputil.WriteJSON(w, http.StatusOK, response{Token: token})
}
