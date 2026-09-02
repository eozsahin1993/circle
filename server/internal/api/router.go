// Package api is the composition root — the "final router outside" that
// wires shared storage components into each endpoint's own service and
// aggregates every endpoint's route registration into one mux. Called
// once by each cmd/ entry point (cmd/lambda, cmd/server), whichever way
// the app ends up served.
package api

import (
	"net/http"

	"circle-relay/internal/api/account/manifest"
	"circle-relay/internal/api/appendentry"
	"circle-relay/internal/api/auth"
	"circle-relay/internal/api/auth/apple"
	"circle-relay/internal/api/auth/google"
	"circle-relay/internal/api/auth/logout"
	"circle-relay/internal/api/auth/oidcverify"
	"circle-relay/internal/api/fetchentries"
	"circle-relay/internal/api/getblob"
	"circle-relay/internal/api/invite"
	"circle-relay/internal/storage/authstore"
	"circle-relay/internal/storage/blobstore"
	"circle-relay/internal/storage/invitestore"
	"circle-relay/internal/storage/logstore"
	"circle-relay/internal/storage/manifeststore"
)

func NewRouter(
	logStore logstore.Store,
	blobStore blobstore.Store,
	authStore authstore.Store,
	manifestStore manifeststore.Store,
	inviteStore invitestore.Store,
	googleVerifier *oidcverify.Verifier,
	appleVerifier *oidcverify.Verifier,
) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("/v1/", http.StripPrefix("/v1", newV1Mux(logStore, blobStore, authStore, manifestStore, inviteStore, googleVerifier, appleVerifier)))
	return mux
}

// newV1Mux is the only version that exists today. When a v2 is needed, add
// a sibling newV2Mux and mount it at "/v2/" alongside this one — existing
// clients keep hitting "/v1/" unchanged, and each endpoint's own Register
// stays unaware that versioning exists at all.
func newV1Mux(
	logStore logstore.Store,
	blobStore blobstore.Store,
	authStore authstore.Store,
	manifestStore manifeststore.Store,
	inviteStore invitestore.Store,
	googleVerifier *oidcverify.Verifier,
	appleVerifier *oidcverify.Verifier,
) *http.ServeMux {
	mux := http.NewServeMux()

	// Grouped under one sub-mux so RequireSession wraps all three at once.
	circleMux := http.NewServeMux()
	appendentry.Register(circleMux, &appendentry.Service{LogStore: logStore, BlobStore: blobStore})
	fetchentries.Register(circleMux, &fetchentries.Service{LogStore: logStore})
	getblob.Register(circleMux, &getblob.Service{BlobStore: blobStore})
	mux.Handle("/circles/", auth.RequireSession(authStore, circleMux))

	// Account-scoped, not circle-scoped — its own sub-mux, same
	// RequireSession wrapping as circleMux above.
	accountMux := http.NewServeMux()
	manifest.Register(accountMux, &manifest.Service{ManifestStore: manifestStore})
	mux.Handle("/account/", auth.RequireSession(authStore, accountMux))

	// Invite-tag-scoped, not circle- or account-scoped — its own sub-mux,
	// same RequireSession wrapping as circleMux/accountMux above. Still
	// requires a session: an unauthenticated caller can't hit any /invites/
	// route, even though the routes themselves don't use the caller's
	// accountID (see server/INVITE_FLOW.md — the relay never learns who's
	// inviting whom).
	invitesMux := http.NewServeMux()
	invite.Register(invitesMux, &invite.Service{InviteStore: inviteStore})
	mux.Handle("/invites/", auth.RequireSession(authStore, invitesMux))

	google.Register(mux, &google.Service{AuthStore: authStore, Verifier: googleVerifier})
	apple.Register(mux, &apple.Service{AuthStore: authStore, Verifier: appleVerifier})
	logout.Register(mux, &logout.Service{AuthStore: authStore})

	return mux
}
