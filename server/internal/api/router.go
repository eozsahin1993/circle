// Package api is the composition root — the "final router outside" that
// wires shared storage components into each endpoint's own service and
// aggregates every endpoint's route registration into one mux. Called
// once by each cmd/ entry point (cmd/lambda, cmd/server), whichever way
// the app ends up served.
package api

import (
	"net/http"

	"circle-relay/internal/api/account/manifest"
	"circle-relay/internal/api/appendlog"
	"circle-relay/internal/api/auth"
	"circle-relay/internal/api/auth/apple"
	"circle-relay/internal/api/auth/google"
	"circle-relay/internal/api/auth/logout"
	"circle-relay/internal/api/auth/oidcverify"
	"circle-relay/internal/api/changeauthority"
	"circle-relay/internal/api/createlog"
	"circle-relay/internal/api/deleteblob"
	"circle-relay/internal/api/deletecircle"
	"circle-relay/internal/api/getblob"
	"circle-relay/internal/api/getcoverphotouploadtarget"
	"circle-relay/internal/api/getepochs"
	"circle-relay/internal/api/getlog"
	"circle-relay/internal/api/getuploadtarget"
	"circle-relay/internal/api/invite"
	"circle-relay/internal/api/push"
	"circle-relay/internal/api/ratelimit"
	"circle-relay/internal/api/rotatelog"
	"circle-relay/internal/storage/authstore"
	"circle-relay/internal/storage/blobstore"
	"circle-relay/internal/storage/invitestore"
	"circle-relay/internal/storage/logstore"
	"circle-relay/internal/storage/manifeststore"
	"circle-relay/internal/storage/pushstore"
	"circle-relay/internal/storage/ratelimitstore"
)

// PushDeps groups the push slice's dependencies. A struct because
// NewRouter already takes two ratelimitstore.Store values, and a third
// positional one would be easy to pass in the wrong order silently.
type PushDeps struct {
	Store          pushstore.Store
	RecipientLimit ratelimitstore.Store
	// Nil until the platform credentials exist: fanout still resolves and
	// reports, it just drops the deliveries.
	Dispatch func(push.Delivery, int64, []byte)
}

// Deps is everything the router wires into its endpoints, named rather
// than positional — four fields share two types (two ratelimitstore.Store,
// two *oidcverify.Verifier), so a positional list let a read budget stand
// in for a write one with nothing to catch it. PushDeps was already a
// struct for the same reason; this finishes the job.
type Deps struct {
	Log      logstore.Store
	Blob     blobstore.Store
	Auth     authstore.Store
	Manifest manifeststore.Store
	Invite   invitestore.Store
	// Writes and reads carry different budgets — see internal/api/ratelimit.
	WriteLimit ratelimitstore.Store
	ReadLimit  ratelimitstore.Store
	Google     *oidcverify.Verifier
	Apple      *oidcverify.Verifier
	Push       PushDeps
}

func NewRouter(deps Deps) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("/v1/", http.StripPrefix("/v1", newV1Mux(deps)))
	return mux
}

// newV1Mux is the only version that exists today. When a v2 is needed, add
// a sibling newV2Mux and mount it at "/v2/" alongside this one — existing
// clients keep hitting "/v1/" unchanged, and each endpoint's own Register
// stays unaware that versioning exists at all.
func newV1Mux(deps Deps) *http.ServeMux {
	mux := http.NewServeMux()

	// Grouped under one sub-mux so RequireSession wraps all eight at once —
	// each endpoint also checks its own write token/authority signature
	// beyond this shared session check (server/SYNC_DESIGN.md's
	// "Authorization" section). Rate limiting wraps each handler
	// individually instead of circleMux as a whole, since writes and reads
	// carry different budgets (see internal/api/ratelimit).
	writeLimit := func(h http.Handler) http.Handler { return ratelimit.Require(deps.WriteLimit, h) }
	readLimit := func(h http.Handler) http.Handler { return ratelimit.Require(deps.ReadLimit, h) }

	circleMux := http.NewServeMux()
	createlog.Register(circleMux, &createlog.Service{LogStore: deps.Log}, writeLimit)
	appendlog.Register(circleMux, &appendlog.Service{LogStore: deps.Log}, writeLimit)
	rotatelog.Register(circleMux, &rotatelog.Service{LogStore: deps.Log}, writeLimit)
	changeauthority.Register(circleMux, &changeauthority.Service{LogStore: deps.Log}, writeLimit)
	deletecircle.Register(circleMux, &deletecircle.Service{LogStore: deps.Log, BlobStore: deps.Blob}, writeLimit)
	getlog.Register(circleMux, &getlog.Service{LogStore: deps.Log}, readLimit)
	getblob.Register(circleMux, &getblob.Service{BlobStore: deps.Blob}, readLimit)
	getuploadtarget.Register(circleMux, &getuploadtarget.Service{BlobStore: deps.Blob, LogStore: deps.Log}, writeLimit)
	deleteblob.Register(circleMux, &deleteblob.Service{BlobStore: deps.Blob, LogStore: deps.Log}, writeLimit)
	getcoverphotouploadtarget.Register(circleMux, &getcoverphotouploadtarget.Service{BlobStore: deps.Blob, LogStore: deps.Log}, writeLimit)
	mux.Handle("/circles/", auth.RequireSession(deps.Auth, circleMux))

	// Account-scoped, not circle-scoped — its own sub-mux, same
	// RequireSession wrapping as circleMux above.
	accountMux := http.NewServeMux()
	manifest.Register(accountMux, &manifest.Service{ManifestStore: deps.Manifest})
	mux.Handle("/account/", auth.RequireSession(deps.Auth, accountMux))

	// Invite-tag-scoped, not circle- or account-scoped — its own sub-mux,
	// same RequireSession wrapping as circleMux/accountMux above. Still
	// requires a session: an unauthenticated caller can't hit any /invites/
	// route, even though the routes themselves don't use the caller's
	// accountID (see server/INVITE_FLOW.md — the relay never learns who's
	// inviting whom).
	invitesMux := http.NewServeMux()
	invite.Register(invitesMux, &invite.Service{InviteStore: deps.Invite})
	mux.Handle("/invites/", auth.RequireSession(deps.Auth, invitesMux))

	// Not circle-scoped in the path (it spans however many circles a
	// device is in, in one call) — its own sub-mux rather than nested
	// under circleMux, same RequireSession wrapping as the others above.
	// readLimit for now, same budget as getlog/getblob — worth revisiting
	// once this is actually polled on its intended ~30s cadence.
	epochsMux := http.NewServeMux()
	getepochs.Register(epochsMux, &getepochs.Service{LogStore: deps.Log}, readLimit)
	mux.Handle("/epochs/", auth.RequireSession(deps.Auth, epochsMux))

	// Registration is session-gated; the send route is not, and mounts on
	// the parent mux — see push.FanoutHandler. "POST /push/send" is more
	// specific than "/push/" so it wins the match; changing either pattern
	// risks silently authenticating the one route that must not be.
	if deps.Push.Store != nil {
		pushService := &push.Service{PushStore: deps.Push.Store, RecipientLimit: deps.Push.RecipientLimit}

		pushMux := http.NewServeMux()
		push.Register(pushMux, pushService)
		mux.Handle("/push/", auth.RequireSession(deps.Auth, pushMux))

		dispatch := deps.Push.Dispatch
		if dispatch == nil {
			dispatch = func(push.Delivery, int64, []byte) {}
		}
		push.RegisterFanout(mux, &push.FanoutHandler{Service: pushService, Dispatch: dispatch})
	}

	google.Register(mux, &google.Service{AuthStore: deps.Auth, Verifier: deps.Google})
	apple.Register(mux, &apple.Service{AuthStore: deps.Auth, Verifier: deps.Apple})
	logout.Register(mux, &logout.Service{AuthStore: deps.Auth})

	return mux
}
