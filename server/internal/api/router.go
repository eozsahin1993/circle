// Package api is the composition root — the "final router outside" that
// wires shared storage components into each endpoint's own service and
// aggregates every endpoint's route registration into one mux. Called
// once by each cmd/ entry point (cmd/lambda, cmd/server), whichever way
// the app ends up served.
package api

import (
	"net/http"

	"circle-relay/internal/api/appendentry"
	"circle-relay/internal/api/auth/apple"
	"circle-relay/internal/api/auth/google"
	"circle-relay/internal/api/auth/logout"
	"circle-relay/internal/api/auth/oidcverify"
	"circle-relay/internal/api/fetchentries"
	"circle-relay/internal/api/getblob"
	"circle-relay/internal/secrets"
	"circle-relay/internal/storage/authstore"
	"circle-relay/internal/storage/blobstore"
	"circle-relay/internal/storage/logstore"
)

func NewRouter(
	logStore logstore.Store,
	blobStore blobstore.Store,
	authStore authstore.Store,
	secretStore secrets.Store,
	googleVerifier *oidcverify.Verifier,
	appleVerifier *oidcverify.Verifier,
) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("/v1/", http.StripPrefix("/v1", newV1Mux(logStore, blobStore, authStore, secretStore, googleVerifier, appleVerifier)))
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
	secretStore secrets.Store,
	googleVerifier *oidcverify.Verifier,
	appleVerifier *oidcverify.Verifier,
) *http.ServeMux {
	mux := http.NewServeMux()

	appendentry.Register(mux, &appendentry.Service{LogStore: logStore, BlobStore: blobStore})
	fetchentries.Register(mux, &fetchentries.Service{LogStore: logStore})
	getblob.Register(mux, &getblob.Service{BlobStore: blobStore})
	google.Register(mux, &google.Service{Secrets: secretStore, AuthStore: authStore, Verifier: googleVerifier})
	apple.Register(mux, &apple.Service{Secrets: secretStore, AuthStore: authStore, Verifier: appleVerifier})
	logout.Register(mux, &logout.Service{AuthStore: authStore})

	return mux
}
