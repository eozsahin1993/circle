// End-to-end tests for GET /epochs, against the fully assembled router —
// see router_test.go's top comment for why this is separate from the
// per-package unit tests.
package api_test

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"circle-relay/internal/testsupport"
)

func TestEndToEnd_Epochs_ReportsCurrentEpochsAndOmitsAnUnknownCircle(t *testing.T) {
	syncID := testsupport.UniqueSyncID(t)
	unknownSyncID := testsupport.UniqueSyncID(t)
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	authToken := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	founderPubHex := hex.EncodeToString(make([]byte, 32))
	writeToken := randomHex(t, 32)
	bootstrapBody := `{"founderAuthorityPublicKey":"` + founderPubHex + `","initialWriteTokenHash":"` + hashToken(writeToken) + `"}`
	bootstrapResp := authedRequest(t, http.MethodPost, server.URL+"/v1/circles/"+syncID, authToken, bootstrapBody)
	defer bootstrapResp.Body.Close()
	if bootstrapResp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201 from bootstrap, got %d", bootstrapResp.StatusCode)
	}

	appendBody := `{"namespace":"content","entryId":"post-1","keyVersion":1,"encryptedMeta":"` +
		base64.StdEncoding.EncodeToString([]byte("ciphertext")) + `","writeToken":"` + writeToken + `"}`
	appendResp := authedRequest(t, http.MethodPost, server.URL+"/v1/circles/"+syncID+"/entries", authToken, appendBody)
	defer appendResp.Body.Close()
	if appendResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from append, got %d", appendResp.StatusCode)
	}

	epochsResp := authedRequest(t, http.MethodGet, server.URL+"/v1/epochs?syncId="+syncID+"&syncId="+unknownSyncID, authToken, "")
	defer epochsResp.Body.Close()
	if epochsResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from epochs, got %d", epochsResp.StatusCode)
	}
	var body struct {
		Circles []struct {
			SyncID       string `json:"syncId"`
			MetaEpoch    int64  `json:"metaEpoch"`
			ContentEpoch int64  `json:"contentEpoch"`
		} `json:"circles"`
	}
	if err := json.NewDecoder(epochsResp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Circles) != 1 {
		t.Fatalf("expected exactly one circle (the unknown one omitted), got %d", len(body.Circles))
	}
	if body.Circles[0].SyncID != syncID {
		t.Fatalf("expected the known circle's syncId %s, got %q", syncID, body.Circles[0].SyncID)
	}
	if body.Circles[0].MetaEpoch != 0 {
		t.Fatalf("expected meta epoch 0 (nothing appended there), got %d", body.Circles[0].MetaEpoch)
	}
	if body.Circles[0].ContentEpoch != 1 {
		t.Fatalf("expected content epoch 1, got %d", body.Circles[0].ContentEpoch)
	}
}

func TestEndToEnd_Epochs_RequiresAtLeastOneSyncID(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	authToken := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	resp := authedRequest(t, http.MethodGet, server.URL+"/v1/epochs", authToken, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 with no syncId, got %d", resp.StatusCode)
	}
}

func TestEndToEnd_Epochs_RequiresAuth(t *testing.T) {
	mux := testsupport.NewRouter(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	resp, err := http.Get(server.URL + "/v1/epochs?syncId=" + testsupport.UniqueSyncID(t))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without a bearer token, got %d", resp.StatusCode)
	}
}
