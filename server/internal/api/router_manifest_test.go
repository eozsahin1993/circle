// End-to-end tests for the account-manifest routes, against the fully
// assembled router — see router_test.go's top comment for why this is
// separate from the per-package unit tests.
package api_test

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"circle-relay/internal/testsupport"
)

func TestEndToEnd_Manifest_GetBeforeAnyPutReturnsNullBlob(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	resp := authedRequest(t, http.MethodGet, server.URL+"/v1/account/manifest", token, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var body struct {
		Blob *string `json:"blob"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Blob != nil {
		t.Fatalf("expected a null blob before any PUT, got %q", *body.Blob)
	}
}

func TestEndToEnd_Manifest_PutThenGetRoundTrips(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	blob := base64.StdEncoding.EncodeToString([]byte("pretend-encrypted-circle-list"))
	putResp := authedRequest(t, http.MethodPut, server.URL+"/v1/account/manifest", token, `{"blob":"`+blob+`"}`)
	defer putResp.Body.Close()
	if putResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from PUT, got %d", putResp.StatusCode)
	}

	getResp := authedRequest(t, http.MethodGet, server.URL+"/v1/account/manifest", token, "")
	defer getResp.Body.Close()
	var body struct {
		Blob *string `json:"blob"`
	}
	if err := json.NewDecoder(getResp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Blob == nil || *body.Blob != blob {
		t.Fatalf("expected blob %q, got %v", blob, body.Blob)
	}
}

func TestEndToEnd_Manifest_RequiresAuth(t *testing.T) {
	mux := testsupport.NewRouter(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	resp, err := http.Get(server.URL + "/v1/account/manifest")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without a bearer token, got %d", resp.StatusCode)
	}
}
