// End-to-end tests against the fully assembled router — real HTTP
// requests in, real HTTP responses out, real DynamoDB/S3 adapters against
// LocalStack underneath. Not covered by the per-package unit tests, which
// call service methods directly and never exercise routing, JSON
// encoding, or base64 handling.
package api_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"circle-relay/internal/storage/logstore"
	"circle-relay/internal/testsupport"
)

// authedRequest sets the bearer token circle content routes require —
// http.Post/http.Get can't set headers, so this replaces them here.
func authedRequest(t *testing.T, method, url, token, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func randomHex(t *testing.T, n int) string {
	t.Helper()
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(buf)
}

func hashToken(tokenHex string) string {
	raw, _ := hex.DecodeString(tokenHex)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func TestEndToEnd_BootstrapAppendFetchRotateAndDownload(t *testing.T) {
	syncID := testsupport.UniqueSyncID(t)
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	authToken := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	founderPub, founderPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	founderPubHex := hex.EncodeToString(founderPub)
	writeToken := randomHex(t, 32)

	// 1. Bootstrap.
	bootstrapBody := `{"founderAuthorityPublicKey":"` + founderPubHex + `","initialWriteTokenHash":"` + hashToken(writeToken) + `"}`
	bootstrapResp := authedRequest(t, http.MethodPost, server.URL+"/v1/circles/"+syncID, authToken, bootstrapBody)
	defer bootstrapResp.Body.Close()
	if bootstrapResp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201 from bootstrap, got %d", bootstrapResp.StatusCode)
	}

	// A second Bootstrap for the same syncId must be rejected.
	dupResp := authedRequest(t, http.MethodPost, server.URL+"/v1/circles/"+syncID, authToken, bootstrapBody)
	defer dupResp.Body.Close()
	if dupResp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 from a duplicate bootstrap, got %d", dupResp.StatusCode)
	}

	// 2. Append a content entry with the founder's write token.
	plaintext := "caption and photo bytes, pretend-encrypted"
	appendBody := `{"namespace":"content","entryId":"post-1","keyVersion":1,"encryptedMeta":"` +
		base64.StdEncoding.EncodeToString([]byte(plaintext)) + `","writeToken":"` + writeToken + `"}`
	appendResp := authedRequest(t, http.MethodPost, server.URL+"/v1/circles/"+syncID+"/entries", authToken, appendBody)
	defer appendResp.Body.Close()
	if appendResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from append, got %d", appendResp.StatusCode)
	}
	var appendResult struct {
		Epoch      int64 `json:"epoch"`
		ReceivedAt int64 `json:"receivedAt"`
	}
	if err := json.NewDecoder(appendResp.Body).Decode(&appendResult); err != nil {
		t.Fatal(err)
	}

	// An append with the wrong write token must be rejected, not silently
	// accepted or consume an epoch.
	wrongTokenBody := `{"namespace":"content","entryId":"post-2","keyVersion":1,"encryptedMeta":"` +
		base64.StdEncoding.EncodeToString([]byte("x")) + `","writeToken":"` + randomHex(t, 32) + `"}`
	wrongTokenResp := authedRequest(t, http.MethodPost, server.URL+"/v1/circles/"+syncID+"/entries", authToken, wrongTokenBody)
	defer wrongTokenResp.Body.Close()
	if wrongTokenResp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for a wrong write token, got %d", wrongTokenResp.StatusCode)
	}

	// 3. Fetch it back from the content namespace.
	fetchResp := authedRequest(t, http.MethodGet, server.URL+"/v1/circles/"+syncID+"/entries?namespace=content&since=0", authToken, "")
	defer fetchResp.Body.Close()
	if fetchResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from fetch, got %d", fetchResp.StatusCode)
	}
	var fetchBody struct {
		Entries []struct {
			Epoch         int64  `json:"epoch"`
			EncryptedMeta string `json:"encryptedMeta"`
		} `json:"entries"`
		CurrentEpoch int64 `json:"currentEpoch"`
	}
	if err := json.NewDecoder(fetchResp.Body).Decode(&fetchBody); err != nil {
		t.Fatal(err)
	}
	if len(fetchBody.Entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(fetchBody.Entries))
	}
	decoded, err := base64.StdEncoding.DecodeString(fetchBody.Entries[0].EncryptedMeta)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded) != plaintext {
		t.Fatalf("expected round-tripped payload %q, got %q", plaintext, string(decoded))
	}
	if fetchBody.CurrentEpoch != appendResult.Epoch {
		t.Fatalf("expected currentEpoch %d, got %d", appendResult.Epoch, fetchBody.CurrentEpoch)
	}

	// The meta namespace must stay empty — nothing was ever appended there.
	metaFetchResp := authedRequest(t, http.MethodGet, server.URL+"/v1/circles/"+syncID+"/entries?namespace=meta&since=0", authToken, "")
	defer metaFetchResp.Body.Close()
	var metaFetchBody struct {
		Entries []json.RawMessage `json:"entries"`
	}
	if err := json.NewDecoder(metaFetchResp.Body).Decode(&metaFetchBody); err != nil {
		t.Fatal(err)
	}
	if len(metaFetchBody.Entries) != 0 {
		t.Fatalf("expected meta namespace to be empty, got %d entries", len(metaFetchBody.Entries))
	}

	// 4. Rotate: swap the write token, signed by the founder's authority key.
	newWriteToken := randomHex(t, 32)
	newWriteTokenHash := hashToken(newWriteToken)
	sig := ed25519.Sign(founderPriv, logstore.RotateMessage(syncID, "rotate-1", newWriteTokenHash))
	rotateBody := `{"entryId":"rotate-1","currentKeyVersion":1,"encryptedMeta":"` + base64.StdEncoding.EncodeToString([]byte("key_rotation payload")) +
		`","currentWriteToken":"` + writeToken + `","newWriteTokenHash":"` + newWriteTokenHash +
		`","authorityPublicKey":"` + founderPubHex + `","signature":"` + hex.EncodeToString(sig) + `"}`
	rotateResp := authedRequest(t, http.MethodPost, server.URL+"/v1/circles/"+syncID+"/rotate", authToken, rotateBody)
	defer rotateResp.Body.Close()
	if rotateResp.StatusCode != http.StatusOK {
		body, _ := json.Marshal(rotateBody)
		t.Fatalf("expected 200 from rotate, got %d (request: %s)", rotateResp.StatusCode, body)
	}

	// The old token must now be rejected...
	staleResp := authedRequest(t, http.MethodPost, server.URL+"/v1/circles/"+syncID+"/entries", authToken,
		`{"namespace":"content","entryId":"post-after-rotation-old-token","keyVersion":1,"encryptedMeta":"YQ==","writeToken":"`+writeToken+`"}`)
	defer staleResp.Body.Close()
	if staleResp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for the pre-rotation write token, got %d", staleResp.StatusCode)
	}
	// ...and the new one must work.
	postRotationResp := authedRequest(t, http.MethodPost, server.URL+"/v1/circles/"+syncID+"/entries", authToken,
		`{"namespace":"content","entryId":"post-after-rotation-new-token","keyVersion":2,"encryptedMeta":"YQ==","writeToken":"`+newWriteToken+`"}`)
	defer postRotationResp.Body.Close()
	if postRotationResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for the post-rotation write token, got %d", postRotationResp.StatusCode)
	}

	// 5. Cover-photo upload target — dual-gated by the (post-rotation,
	// still current) write token *and* an authority signature, since the
	// object it points at has no per-upload existence check to fall back
	// on (see blobstore.Store.GetCoverPhotoUploadTarget). POST with every
	// credential in the body, not a query param — see
	// getcoverphotouploadtarget/handler.go's doc comment for why.
	coverSig := ed25519.Sign(founderPriv, logstore.CoverPhotoUploadMessage(syncID))
	coverBody := `{"writeToken":"` + newWriteToken + `","authorityPublicKey":"` + founderPubHex + `","signature":"` + hex.EncodeToString(coverSig) + `"}`
	coverResp := authedRequest(t, http.MethodPost, server.URL+"/v1/circles/"+syncID+"/cover-photo/upload", authToken, coverBody)
	defer coverResp.Body.Close()
	if coverResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from cover-photo upload target, got %d", coverResp.StatusCode)
	}
	var coverTarget struct {
		Fields map[string]string `json:"fields"`
	}
	if err := json.NewDecoder(coverResp.Body).Decode(&coverTarget); err != nil {
		t.Fatal(err)
	}
	if coverTarget.Fields["key"] != syncID+"/cover" {
		t.Fatalf("expected cover-photo upload key %s/cover, got %q", syncID, coverTarget.Fields["key"])
	}

	// A non-authority signer must be rejected even with a valid write token.
	strangerPub, strangerPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	strangerSig := ed25519.Sign(strangerPriv, logstore.CoverPhotoUploadMessage(syncID))
	strangerBody := `{"writeToken":"` + newWriteToken + `","authorityPublicKey":"` + hex.EncodeToString(strangerPub) + `","signature":"` + hex.EncodeToString(strangerSig) + `"}`
	strangerResp := authedRequest(t, http.MethodPost, server.URL+"/v1/circles/"+syncID+"/cover-photo/upload", authToken, strangerBody)
	defer strangerResp.Body.Close()
	if strangerResp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for a non-authority signer, got %d", strangerResp.StatusCode)
	}

	// 6. Upload target — gated by the (post-rotation, still current)
	// write token, keyed by entryId rather than epoch. POST with the
	// token in the body, same reasoning as the cover-photo target above.
	uploadResp := authedRequest(t, http.MethodPost, server.URL+"/v1/circles/"+syncID+"/entries/post-1/upload", authToken, `{"writeToken":"`+writeToken+`"}`)
	defer uploadResp.Body.Close()
	if uploadResp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for an upload target requested with the pre-rotation write token, got %d", uploadResp.StatusCode)
	}

	// 6. Blob download redirect — unrelated to whether anything was
	// actually uploaded; getblob just presigns a GET for the deterministic
	// key and redirects there.
	wantSuffix := syncID + "/post-1"
	blobReq, err := http.NewRequest(http.MethodGet, server.URL+"/v1/circles/"+syncID+"/entries/post-1/blob", nil)
	if err != nil {
		t.Fatal(err)
	}
	blobReq.Header.Set("Authorization", "Bearer "+authToken)
	client := &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	blobResp, err := client.Do(blobReq)
	if err != nil {
		t.Fatal(err)
	}
	defer blobResp.Body.Close()
	if blobResp.StatusCode != http.StatusFound {
		t.Fatalf("expected 302 redirect from blob endpoint, got %d", blobResp.StatusCode)
	}
	location := blobResp.Header.Get("Location")
	if !strings.Contains(location, wantSuffix) {
		t.Fatalf("expected redirect location to reference %s, got %q", wantSuffix, location)
	}
}
