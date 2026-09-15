// Package deleteaccount is the vertical slice for DELETE /account — the
// final relay call an account ever makes. Deletes the manifest (the one
// piece of account-keyed storage) and revokes every session for the
// account, not just the one making this call — another signed-in device
// must not be able to outlive the account it belonged to.
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

// Delete removes the manifest first, sessions second — reversed, a
// failure between the two would leave a signed-out account whose
// manifest survives with no session left to retry the delete under.
func (s *Service) Delete(ctx context.Context, accountID string) error {
	if err := s.ManifestStore.DeleteManifest(ctx, accountID); err != nil {
		return err
	}
	return s.AuthStore.DeleteAllSessions(ctx, accountID)
}

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
