// End-to-end tests for DELETE /v1/account, against the fully assembled
// router — see router_test.go's top comment for why this is separate
// from the per-package unit tests.
package api_test

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"circle-relay/internal/testsupport"
)

func TestEndToEnd_DeleteAccount_RemovesTheManifestAndRevokesTheSession(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	email := testsupport.UniqueEmail(t)
	claims := validClaims(t, email, testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	blob := base64.StdEncoding.EncodeToString([]byte("pretend-encrypted-circle-list"))
	putResp := authedRequest(t, http.MethodPut, server.URL+"/v1/account/manifest", token, `{"blob":"`+blob+`"}`)
	putResp.Body.Close()

	deleteResp := authedRequest(t, http.MethodDelete, server.URL+"/v1/account", token, "")
	defer deleteResp.Body.Close()
	if deleteResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from DELETE, got %d", deleteResp.StatusCode)
	}

	// The session died with the account.
	afterResp := authedRequest(t, http.MethodGet, server.URL+"/v1/account/manifest", token, "")
	defer afterResp.Body.Close()
	if afterResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 after account deletion, got %d", afterResp.StatusCode)
	}

	// A fresh sign-in with the same identity starts blank — the manifest
	// really is gone, not just unreachable. Same sub: accountID is
	// "google:<sub>", and validClaims mints a unique one per call.
	claims2 := validClaims(t, email, testsupport.TestGoogleClientID)
	claims2["iss"] = google.Issuer
	claims2["sub"] = claims["sub"]
	token2 := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims2)))
	getResp := authedRequest(t, http.MethodGet, server.URL+"/v1/account/manifest", token2, "")
	defer getResp.Body.Close()
	var body struct {
		Blob *string `json:"blob"`
	}
	if err := json.NewDecoder(getResp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Blob != nil {
		t.Fatalf("expected a null blob after account deletion, got %q", *body.Blob)
	}
}

// The case DeleteAllSessions exists for: a second device signed into the
// same account must not be able to outlive the account it belonged to.
func TestEndToEnd_DeleteAccount_RevokesEveryDevicesSession(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	email := testsupport.UniqueEmail(t)
	claims := validClaims(t, email, testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	deviceA := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	// Same identity, a second sign-in — a second device's session.
	claims2 := validClaims(t, email, testsupport.TestGoogleClientID)
	claims2["iss"] = google.Issuer
	claims2["sub"] = claims["sub"]
	deviceB := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims2)))

	deleteResp := authedRequest(t, http.MethodDelete, server.URL+"/v1/account", deviceA, "")
	deleteResp.Body.Close()
	if deleteResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from DELETE, got %d", deleteResp.StatusCode)
	}

	bResp := authedRequest(t, http.MethodGet, server.URL+"/v1/account/manifest", deviceB, "")
	defer bResp.Body.Close()
	if bResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected device B's session to be revoked too, got %d", bResp.StatusCode)
	}
}

func TestEndToEnd_DeleteAccount_RequiresAuth(t *testing.T) {
	mux := testsupport.NewRouter(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	req, err := http.NewRequest(http.MethodDelete, server.URL+"/v1/account", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without a bearer token, got %d", resp.StatusCode)
	}
}
