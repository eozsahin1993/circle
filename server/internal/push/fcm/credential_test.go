package fcm

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

const validKey = `{
  "project_id": "circle-3ee1d",
  "client_email": "sender@circle.iam.gserviceaccount.com",
  "private_key": "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n",
  "token_uri": "https://oauth2.googleapis.com/token"
}`

func TestParsesAServiceAccountKey(t *testing.T) {
	var account ServiceAccount
	if err := json.Unmarshal([]byte(validKey), &account); err != nil {
		t.Fatal(err)
	}
	if account.ProjectID != "circle-3ee1d" || account.ClientEmail == "" || account.PrivateKey == "" {
		t.Fatalf("key did not parse: %+v", account)
	}
}

// A parse failure must never quote the input, which is a private key.
func TestParseFailureDoesNotLeakTheKey(t *testing.T) {
	loader := &Loader{ParameterName: "/circle/fcm-service-account"}
	loader.once.Do(func() {
		var account ServiceAccount
		if err := json.Unmarshal([]byte("not json at all"), &account); err != nil {
			loader.err = errNotAKey(loader.ParameterName)
		}
	})

	_, err := loader.Load(context.Background())
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "not json at all") {
		t.Fatalf("the error quoted its input: %v", err)
	}
}
