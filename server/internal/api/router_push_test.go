// End-to-end tests for the push routes, against the fully assembled
// router — see router_test.go's top comment for why this is separate from
// the per-package unit tests.
package api_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"circle-relay/internal/api/push"
	"circle-relay/internal/testsupport"
)

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func jsonBody(b []byte) io.Reader { return bytes.NewReader(b) }

// registerPush puts a routing id's prefs and one device in place, and
// returns the fanout token a sender would need for it.
func registerPush(t *testing.T, serverURL, token, routingID string) []byte {
	t.Helper()
	fanoutToken := []byte("fanout-token-for-" + routingID)

	body, err := json.Marshal(map[string]any{
		"fanoutHash": b64(push.FanoutHash(fanoutToken, routingID)),
		"categories": []int64{0, 1},
		"keyVersion": 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	resp := authedRequest(t, http.MethodPut, serverURL+"/v1/push/"+routingID, token, string(body))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from PUT prefs, got %d", resp.StatusCode)
	}

	deviceBody, err := json.Marshal(map[string]any{
		"pushToken": b64([]byte("encrypted-token")),
		"platform":  "ios",
		"enabled":   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	deviceResp := authedRequest(t, http.MethodPut, serverURL+"/v1/push/"+routingID+"/devices/device-1", token, string(deviceBody))
	defer deviceResp.Body.Close()
	if deviceResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from PUT device, got %d", deviceResp.StatusCode)
	}
	return fanoutToken
}

func sendPush(t *testing.T, serverURL string, routingIDs []string, fanoutToken []byte, category int64) (int, map[string]int) {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"routingIds":  routingIDs,
		"fanoutToken": b64(fanoutToken),
		"category":    category,
		"payload":     b64([]byte("ciphertext")),
	})
	if err != nil {
		t.Fatal(err)
	}

	// Deliberately no bearer token: this route authorizes on the fanout
	// token instead. See push.FanoutHandler.
	resp, err := http.Post(serverURL+"/v1/push/send", "application/json", jsonBody(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode, nil
	}
	var decoded map[string]int
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, decoded
}

func TestEndToEnd_Push_RegisterRequiresAuth(t *testing.T) {
	mux := testsupport.NewRouter(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	resp, err := http.Post(server.URL+"/v1/push/some-routing-id", "application/json", jsonBody([]byte("{}")))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatal("registration must require a session")
	}
}

// The one route that must stay reachable without a session — and the one
// most likely to be broken by a change to the "/push/" pattern.
func TestEndToEnd_Push_SendDoesNotRequireAuth(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	routingID := testsupport.UniqueInviteTag(t)
	fanoutToken := registerPush(t, server.URL, token, routingID)

	status, result := sendPush(t, server.URL, []string{routingID}, fanoutToken, 0)
	if status != http.StatusOK {
		t.Fatalf("expected 200 from an unauthenticated send, got %d", status)
	}
	if result["delivered"] != 1 {
		t.Fatalf("expected 1 delivery, got %+v", result)
	}
}

func TestEndToEnd_Push_WrongFanoutTokenDeliversNothing(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	routingID := testsupport.UniqueInviteTag(t)
	registerPush(t, server.URL, token, routingID)

	status, result := sendPush(t, server.URL, []string{routingID}, []byte("another-circles-token"), 0)
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d", status)
	}
	// 200 with nothing delivered, not an error: the caller must not learn
	// whether the routing id exists.
	if result["delivered"] != 0 || result["skipped"] != 1 {
		t.Fatalf("expected nothing delivered, got %+v", result)
	}
}

func TestEndToEnd_Push_UnregisteringSilencesTheCircle(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	routingID := testsupport.UniqueInviteTag(t)
	fanoutToken := registerPush(t, server.URL, token, routingID)

	deleteResp := authedRequest(t, http.MethodDelete, server.URL+"/v1/push/"+routingID, token, "")
	defer deleteResp.Body.Close()
	if deleteResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from DELETE, got %d", deleteResp.StatusCode)
	}

	_, result := sendPush(t, server.URL, []string{routingID}, fanoutToken, 0)
	if result["delivered"] != 0 {
		t.Fatalf("a silenced circle must deliver nothing, got %+v", result)
	}
}

func TestEndToEnd_Push_RejectsShortFanoutHash(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	body, _ := json.Marshal(map[string]any{"fanoutHash": b64([]byte("short")), "categories": []int64{0}})
	resp := authedRequest(t, http.MethodPut, server.URL+"/v1/push/"+testsupport.UniqueInviteTag(t), token, string(body))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for a short fanoutHash, got %d", resp.StatusCode)
	}
}
