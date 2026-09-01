package testsupport

import (
	"net/http"
	"testing"

	"circle-relay/internal/api"
	"circle-relay/internal/api/auth/oidcverify"
)

// NewRouterWithAuth builds the full api.NewRouter against real
// LocalStack-backed adapters, plus fake (but real-HTTP, real-JWT)
// Google/Apple OIDC providers — for tests that need to mint valid ID
// tokens themselves (router_auth_test.go). Tests that don't touch auth
// endpoints should use NewRouter instead.
func NewRouterWithAuth(t testing.TB) (mux *http.ServeMux, google, apple *FakeOIDCProvider) {
	t.Helper()
	google = NewFakeOIDCProvider(t, "https://accounts.google.com")
	apple = NewFakeOIDCProvider(t, "https://appleid.apple.com")
	mux = api.NewRouter(
		NewLogStore(t, 0),
		NewBlobStore(t),
		NewAuthStore(t),
		NewSecretStore(t),
		oidcverify.New(google.Issuer, google.JWKSURL, []string{TestGoogleClientID}),
		oidcverify.New(apple.Issuer, apple.JWKSURL, []string{TestAppleClientID}),
	)
	return mux, google, apple
}

// NewRouter is NewRouterWithAuth without the provider handles, for tests
// that just need a working router and don't touch auth endpoints — the one
// router construction path every other end-to-end test in package api_test
// should use, so a change to api.NewRouter's signature only means updating
// this one place, not every test file.
func NewRouter(t testing.TB) *http.ServeMux {
	t.Helper()
	mux, _, _ := NewRouterWithAuth(t)
	return mux
}
