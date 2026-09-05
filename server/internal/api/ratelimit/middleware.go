// Package ratelimit gates handlers behind a per-account request budget.
// See server/internal/storage/ratelimitstore for the storage side.
package ratelimit

import (
	"log"
	"net/http"

	"circle-relay/internal/api/auth"
	"circle-relay/internal/httputil"
	"circle-relay/internal/storage/ratelimitstore"
)

// Require gates next behind store's budget for the request's authenticated
// account. Must be composed *inside* (after) auth.RequireSession, since it
// reads the account ID that middleware stashes in context — composing it
// outside would see an empty account ID for every caller.
//
// Fails open (allows the request, logs the error) if the store itself
// errors — a rate-limit store outage shouldn't turn into a write outage
// for every account.
func Require(store ratelimitstore.Store, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		accountID := auth.AccountID(r.Context())

		allowed, err := store.Allow(r.Context(), accountID)
		if err != nil {
			log.Printf("rate limit check failed for account %s, allowing request: %v", accountID, err)
			next.ServeHTTP(w, r)
			return
		}
		if !allowed {
			httputil.WriteError(w, http.StatusTooManyRequests, "rate limit exceeded, try again shortly")
			return
		}

		next.ServeHTTP(w, r)
	})
}
