// Package deleteaccount is the vertical slice for DELETE /account — the
// final relay call an account ever makes. Deletes the manifest (the one
// piece of account-keyed storage) and revokes the calling session.
//
// Other outstanding sessions for the account can't be enumerated —
// sessions are keyed by token with no account index, by design — so they
// age out on their own TTL; everything account-keyed they could touch is
// already gone by then.
package deleteaccount

import (
	"context"
	"net/http"

	"circle-relay/internal/api/auth"
	"circle-relay/internal/httputil"
	"circle-relay/internal/storage/authstore"
	"circle-relay/internal/storage/manifeststore"
)

type Service struct {
	ManifestStore manifeststore.Store
	AuthStore     authstore.Store
}

// Delete removes the manifest first, the session second — reversed, a
// failure between the two would leave a signed-out caller whose manifest
// survives with no session to retry the delete under.
func (s *Service) Delete(ctx context.Context, accountID, token string) error {
	if err := s.ManifestStore.DeleteManifest(ctx, accountID); err != nil {
		return err
	}
	return s.AuthStore.DeleteSession(ctx, token)
}

type response struct {
	OK bool `json:"ok"`
}

type Handler struct {
	Service *Service
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	token, ok := httputil.BearerToken(r)
	if !ok {
		httputil.WriteError(w, http.StatusBadRequest, "missing bearer token")
		return
	}
	if err := h.Service.Delete(r.Context(), auth.AccountID(r.Context()), token); err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to delete account")
		return
	}
	httputil.WriteJSON(w, http.StatusOK, response{OK: true})
}

// Register mounts this endpoint's route onto mux. The exact "/account"
// pattern (no trailing slash) can't live inside the "/account/" subtree
// sub-mux — ServeMux answers the bare path there with a redirect, which
// DELETE callers won't follow — so this registers on the parent mux and
// wraps its own session check via wrap.
func Register(mux *http.ServeMux, service *Service, wrap func(http.Handler) http.Handler) {
	var h http.Handler = &Handler{Service: service}
	if wrap != nil {
		h = wrap(h)
	}
	mux.Handle("DELETE /account", h)
}
