package auth

import (
	"context"
	"net/http"
	"time"

	"circle-relay/internal/httputil"
	"circle-relay/internal/storage/authstore"
)

type contextKey int

const accountIDKey contextKey = iota

// RequireSession gates next behind a valid, unexpired bearer token. Not
// applied to the sign-in routes (that's how you get a token) or logout
// (must accept an already-dead token as a no-op success).
func RequireSession(authStore authstore.Store, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := httputil.BearerToken(r)
		if !ok {
			httputil.WriteError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}

		session, err := authStore.GetSession(r.Context(), token)
		if err != nil {
			httputil.WriteError(w, http.StatusInternalServerError, "failed to look up session")
			return
		}
		// GetSession's TTL cleanup is best-effort, so a just-expired
		// session can still come back non-nil — check ExpiresAt directly.
		if session == nil || session.ExpiresAt.Before(time.Now()) {
			httputil.WriteError(w, http.StatusUnauthorized, "invalid or expired session")
			return
		}

		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), accountIDKey, session.AccountID)))
	})
}

// AccountID returns the authenticated account ("google:<sub>",
// "apple:<sub>", ...), or "" if this request never went through
// RequireSession.
func AccountID(ctx context.Context) string {
	accountID, _ := ctx.Value(accountIDKey).(string)
	return accountID
}
