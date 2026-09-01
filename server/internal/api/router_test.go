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

func TestEndToEnd_AppendThenFetchThenDownload(t *testing.T) {
	circleLogID := testsupport.UniqueCircleID(t)
	mux := testsupport.NewRouter(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	plaintext := "caption and photo bytes, pretend-encrypted"
	body := `{"entryId":"post-1","encryptedMeta":"` + base64.StdEncoding.EncodeToString([]byte(plaintext)) + `"}`

	appendResp, err := http.Post(server.URL+"/v1/circles/"+circleLogID+"/entries", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
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

	fetchResp, err := http.Get(server.URL + "/v1/circles/" + circleLogID + "/entries?since=0")
	if err != nil {
		t.Fatal(err)
	}
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

	// The blob endpoint should redirect (302) to a download URL — the
	// http.Client follows the redirect by default, ending up at the real
	// S3-via-LocalStack destination, which 404s (nothing was ever
	// "uploaded" in this test — appending only reserves the slot, upload
	// is a separate step the client does directly against S3 as a
	// presigned POST using the append response's upload target). That
	// 404 is expected here, not a failure of this handler: what's under
	// test is that a redirect happens at all, and to the right place.
	client := &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	blobResp, err := client.Get(server.URL + "/v1/circles/" + circleLogID + "/entries/" + strconv.FormatInt(appendBody.Epoch, 10) + "/blob")
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
