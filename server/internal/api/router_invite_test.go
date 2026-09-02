// End-to-end tests for the invite routes, against the fully
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

func TestEndToEnd_Invite_RequiresAuth(t *testing.T) {
	mux := testsupport.NewRouter(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	resp, err := http.Get(server.URL + "/v1/invites/some-tag")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without a bearer token, got %d", resp.StatusCode)
	}
}

func TestEndToEnd_Invite_GetUnknownInviteReturns404(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	resp := authedRequest(t, http.MethodGet, server.URL+"/v1/invites/"+testsupport.UniqueInviteTag(t), token, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for an invite tag that was never created, got %d", resp.StatusCode)
	}
}

// TestEndToEnd_Invite_FullRoundTrip walks the whole server-side
// handshake described in server/INVITE_FLOW.md: create invite -> get
// invite -> put join request -> list requests -> approve -> get request
// shows the approval.
func TestEndToEnd_Invite_FullRoundTrip(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	inviteTag := testsupport.UniqueInviteTag(t)
	requesterID := "requester-1"

	preview := base64.StdEncoding.EncodeToString([]byte("pretend-encrypted-preview"))
	putInviteResp := authedRequest(t, http.MethodPut, server.URL+"/v1/invites/"+inviteTag, token, `{"encryptedPreview":"`+preview+`"}`)
	defer putInviteResp.Body.Close()
	if putInviteResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from PUT invite, got %d", putInviteResp.StatusCode)
	}

	getInviteResp := authedRequest(t, http.MethodGet, server.URL+"/v1/invites/"+inviteTag, token, "")
	defer getInviteResp.Body.Close()
	if getInviteResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from GET invite, got %d", getInviteResp.StatusCode)
	}
	var getInviteBody struct {
		EncryptedPreview string `json:"encryptedPreview"`
	}
	if err := json.NewDecoder(getInviteResp.Body).Decode(&getInviteBody); err != nil {
		t.Fatal(err)
	}
	if getInviteBody.EncryptedPreview != preview {
		t.Fatalf("expected encryptedPreview %q, got %q", preview, getInviteBody.EncryptedPreview)
	}

	request := base64.StdEncoding.EncodeToString([]byte("pretend-encrypted-join-request"))
	putRequestResp := authedRequest(t, http.MethodPut, server.URL+"/v1/invites/"+inviteTag+"/requests/"+requesterID, token, `{"encryptedRequest":"`+request+`"}`)
	defer putRequestResp.Body.Close()
	if putRequestResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from PUT join request, got %d", putRequestResp.StatusCode)
	}

	listResp := authedRequest(t, http.MethodGet, server.URL+"/v1/invites/"+inviteTag+"/requests", token, "")
	defer listResp.Body.Close()
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from list requests, got %d", listResp.StatusCode)
	}
	var listBody struct {
		Requests []struct {
			RequesterID       string  `json:"requesterId"`
			EncryptedRequest  string  `json:"encryptedRequest"`
			EncryptedApproval *string `json:"encryptedApproval"`
			CreatedAt         int64   `json:"createdAt"`
		} `json:"requests"`
	}
	if err := json.NewDecoder(listResp.Body).Decode(&listBody); err != nil {
		t.Fatal(err)
	}
	if len(listBody.Requests) != 1 {
		t.Fatalf("expected 1 pending request, got %d", len(listBody.Requests))
	}
	if listBody.Requests[0].RequesterID != requesterID {
		t.Fatalf("expected requesterId %q, got %q", requesterID, listBody.Requests[0].RequesterID)
	}
	if listBody.Requests[0].EncryptedApproval != nil {
		t.Fatalf("expected no approval yet, got %q", *listBody.Requests[0].EncryptedApproval)
	}

	approval := base64.StdEncoding.EncodeToString([]byte("pretend-sealed-box-approval"))
	putApprovalResp := authedRequest(t, http.MethodPut, server.URL+"/v1/invites/"+inviteTag+"/requests/"+requesterID+"/approval", token, `{"encryptedApproval":"`+approval+`"}`)
	defer putApprovalResp.Body.Close()
	if putApprovalResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from PUT approval, got %d", putApprovalResp.StatusCode)
	}

	getRequestResp := authedRequest(t, http.MethodGet, server.URL+"/v1/invites/"+inviteTag+"/requests/"+requesterID, token, "")
	defer getRequestResp.Body.Close()
	if getRequestResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from GET join request, got %d", getRequestResp.StatusCode)
	}
	var getRequestBody struct {
		RequesterID       string  `json:"requesterId"`
		EncryptedRequest  string  `json:"encryptedRequest"`
		EncryptedApproval *string `json:"encryptedApproval"`
		CreatedAt         int64   `json:"createdAt"`
	}
	if err := json.NewDecoder(getRequestResp.Body).Decode(&getRequestBody); err != nil {
		t.Fatal(err)
	}
	if getRequestBody.EncryptedApproval == nil || *getRequestBody.EncryptedApproval != approval {
		t.Fatalf("expected approval %q, got %v", approval, getRequestBody.EncryptedApproval)
	}
}

func TestEndToEnd_Invite_GetUnknownRequestReturns404(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	resp := authedRequest(t, http.MethodGet, server.URL+"/v1/invites/"+testsupport.UniqueInviteTag(t)+"/requests/nobody", token, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for a requester that never submitted, got %d", resp.StatusCode)
	}
}

func TestEndToEnd_Invite_ApproveUnknownRequestReturns404(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	approval := base64.StdEncoding.EncodeToString([]byte("pretend-sealed-box-approval"))
	resp := authedRequest(t, http.MethodPut, server.URL+"/v1/invites/"+testsupport.UniqueInviteTag(t)+"/requests/nobody/approval", token, `{"encryptedApproval":"`+approval+`"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 approving a join request that was never made, got %d", resp.StatusCode)
	}
}
