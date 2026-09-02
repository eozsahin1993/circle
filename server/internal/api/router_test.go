// End-to-end tests against the fully assembled router — real HTTP
// requests in, real HTTP responses out, real DynamoDB/S3 adapters against
// LocalStack underneath. Not covered by the per-package unit tests, which
// call service methods directly and never exercise routing, JSON
// encoding, or base64 handling.
package api_test

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"circle-relay/internal/testsupport"
)

// authedRequest sets the bearer token circle content routes now require —
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

func TestEndToEnd_AppendThenFetchThenDownload(t *testing.T) {
	circleLogID := testsupport.UniqueCircleID(t)
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	plaintext := "caption and photo bytes, pretend-encrypted"
	body := `{"entryId":"post-1","encryptedMeta":"` + base64.StdEncoding.EncodeToString([]byte(plaintext)) + `"}`

	appendResp := authedRequest(t, http.MethodPost, server.URL+"/v1/circles/"+circleLogID+"/entries", token, body)
	defer appendResp.Body.Close()
	if appendResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from append, got %d", appendResp.StatusCode)
	}

	var appendBody struct {
		Epoch      int64 `json:"epoch"`
		ReceivedAt int64 `json:"receivedAt"`
		Upload     struct {
			URL    string            `json:"url"`
			Fields map[string]string `json:"fields"`
		} `json:"upload"`
	}
	if err := json.NewDecoder(appendResp.Body).Decode(&appendBody); err != nil {
		t.Fatal(err)
	}
	wantSuffix := circleLogID + "/" + strconv.FormatInt(appendBody.Epoch, 10)
	if appendBody.Upload.Fields["key"] != wantSuffix {
		t.Fatalf("expected upload fields' key to be %s, got %q", wantSuffix, appendBody.Upload.Fields["key"])
	}

	fetchResp := authedRequest(t, http.MethodGet, server.URL+"/v1/circles/"+circleLogID+"/entries?since=0", token, "")
	defer fetchResp.Body.Close()
	if fetchResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from fetch, got %d", fetchResp.StatusCode)
	}

	var fetchBody struct {
		Entries []struct {
			Epoch         int64  `json:"epoch"`
			EncryptedMeta string `json:"encryptedMeta"`
			ReceivedAt    int64  `json:"receivedAt"`
		} `json:"entries"`
		LatestEpoch          int64 `json:"latestEpoch"`
		OldestAvailableEpoch int64 `json:"oldestAvailableEpoch"`
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
	if fetchBody.LatestEpoch != appendBody.Epoch {
		t.Fatalf("expected latestEpoch %d, got %d", appendBody.Epoch, fetchBody.LatestEpoch)
	}

	// Should redirect (302) to a presigned S3 URL, not follow it — nothing
	// was actually uploaded in this test, only the append call happened.
	blobReq, err := http.NewRequest(http.MethodGet, server.URL+"/v1/circles/"+circleLogID+"/entries/"+strconv.FormatInt(appendBody.Epoch, 10)+"/blob", nil)
	if err != nil {
		t.Fatal(err)
	}
	blobReq.Header.Set("Authorization", "Bearer "+token)
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
