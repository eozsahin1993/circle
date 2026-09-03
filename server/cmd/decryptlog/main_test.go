package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"

	"golang.org/x/crypto/chacha20poly1305"

	"circle-relay/internal/storage/dynamoutil"
	"circle-relay/internal/storage/logstore"
	"circle-relay/internal/testsupport"
)

// Exercises the tool against a real (LocalStack) table, through the same
// Bootstrap/Append calls production code uses, rather than hand-writing
// DynamoDB items — a regression test that decodeItem actually understands
// today's real item shape, not just the shape this file assumes it is.
func TestDecodeItem_RoundTripsARealBootstrappedAndAppendedCircle(t *testing.T) {
	store := testsupport.NewLogStore(t)
	client, table := testsupport.RawDynamoDBClient(t)
	ctx := context.Background()
	syncID := testsupport.UniqueSyncID(t)

	authorityPub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("failed to generate authority key: %v", err)
	}
	authorityPubHex := hex.EncodeToString(authorityPub)

	contentKey := make([]byte, 32)
	if _, err := rand.Read(contentKey); err != nil {
		t.Fatalf("failed to generate content key: %v", err)
	}
	// The tool never inspects the write token itself, so any distinct raw
	// value works here — production derives it from the content key
	// (see crypto.ts's deriveWriteToken), which isn't necessary for this test.
	writeToken := make([]byte, 32)
	if _, err := rand.Read(writeToken); err != nil {
		t.Fatalf("failed to generate write token: %v", err)
	}
	writeTokenHex := hex.EncodeToString(writeToken)
	writeTokenHashSum := sha256.Sum256(writeToken)
	writeTokenHashHex := hex.EncodeToString(writeTokenHashSum[:])

	if err := store.Bootstrap(ctx, syncID, authorityPubHex, writeTokenHashHex); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}

	envelope := logEntryEnvelope{
		Type:         "post",
		Payload:      json.RawMessage(`{"caption":"hello world"}`),
		AuthorPubkey: authorityPubHex,
		Signature:    "deadbeef",
	}
	plaintext, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("failed to marshal envelope: %v", err)
	}
	encrypted, err := encryptForTest(plaintext, contentKey)
	if err != nil {
		t.Fatalf("failed to encrypt test entry: %v", err)
	}

	commit, err := store.Append(ctx, syncID, logstore.NamespaceMeta, "entry-1", encrypted, 1, writeTokenHex)
	if err != nil {
		t.Fatalf("Append: %v", err)
	}

	items, err := queryAllItems(ctx, client, table, syncID)
	if err != nil {
		t.Fatalf("queryAllItems: %v", err)
	}

	keys := contentKeys{1: contentKey}
	var sawControl, sawEntry bool
	for _, item := range items {
		sk, _ := dynamoutil.AttrString(item, dynamoutil.SKAttr)
		decoded := decodeItem(sk, item, keys)

		if decoded.Control != nil {
			sawControl = true
			if decoded.Control["writeTokenHash"] != writeTokenHashHex {
				t.Errorf("control writeTokenHash = %v, want %s", decoded.Control["writeTokenHash"], writeTokenHashHex)
			}
			authoritySet, _ := decoded.Control["authoritySet"].([]string)
			if len(authoritySet) != 1 || authoritySet[0] != authorityPubHex {
				t.Errorf("control authoritySet = %v, want [%s]", authoritySet, authorityPubHex)
			}
			continue
		}

		if decoded.Entry == nil {
			if decoded.Error == "" {
				t.Errorf("item %q decoded to neither control, entry, nor error", sk)
			}
			continue
		}

		sawEntry = true
		if decoded.Namespace != "meta" {
			t.Errorf("Namespace = %q, want %q", decoded.Namespace, "meta")
		}
		if decoded.Epoch != commit.Epoch {
			t.Errorf("Epoch = %d, want %d", decoded.Epoch, commit.Epoch)
		}
		if decoded.KeyVersion != 1 {
			t.Errorf("KeyVersion = %d, want 1", decoded.KeyVersion)
		}
		if decoded.Entry.Type != "post" {
			t.Errorf("Entry.Type = %q, want %q", decoded.Entry.Type, "post")
		}
		if string(decoded.Entry.Payload) != `{"caption":"hello world"}` {
			t.Errorf("Entry.Payload = %s, want %s", decoded.Entry.Payload, `{"caption":"hello world"}`)
		}
		if decoded.Entry.AuthorPubkey != authorityPubHex {
			t.Errorf("Entry.AuthorPubkey = %q, want %q", decoded.Entry.AuthorPubkey, authorityPubHex)
		}
	}

	if !sawControl {
		t.Error("never saw a decoded #control item")
	}
	if !sawEntry {
		t.Error("never saw a decoded log entry")
	}
}

func TestDecodeItem_ReportsAWrongContentKeyInsteadOfFailingSilently(t *testing.T) {
	store := testsupport.NewLogStore(t)
	client, table := testsupport.RawDynamoDBClient(t)
	ctx := context.Background()
	syncID := testsupport.UniqueSyncID(t)

	authorityPub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("failed to generate authority key: %v", err)
	}
	writeToken := make([]byte, 32)
	if _, err := rand.Read(writeToken); err != nil {
		t.Fatalf("failed to generate write token: %v", err)
	}
	writeTokenHashSum := sha256.Sum256(writeToken)
	if err := store.Bootstrap(ctx, syncID, hex.EncodeToString(authorityPub), hex.EncodeToString(writeTokenHashSum[:])); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}

	realKey := make([]byte, 32)
	rand.Read(realKey)
	encrypted, err := encryptForTest([]byte(`{"type":"post","payload":{},"authorPubkey":"","signature":""}`), realKey)
	if err != nil {
		t.Fatalf("failed to encrypt test entry: %v", err)
	}
	if _, err := store.Append(ctx, syncID, logstore.NamespaceContent, "entry-1", encrypted, 1, hex.EncodeToString(writeToken)); err != nil {
		t.Fatalf("Append: %v", err)
	}

	items, err := queryAllItems(ctx, client, table, syncID)
	if err != nil {
		t.Fatalf("queryAllItems: %v", err)
	}

	wrongKey := make([]byte, 32)
	rand.Read(wrongKey)
	keys := contentKeys{1: wrongKey}
	found := false
	for _, item := range items {
		sk, _ := dynamoutil.AttrString(item, dynamoutil.SKAttr)
		decoded := decodeItem(sk, item, keys)
		if decoded.Namespace != "content" {
			continue
		}
		found = true
		if decoded.Entry != nil {
			t.Errorf("decrypted with the wrong key instead of failing")
		}
		if decoded.Error == "" {
			t.Error("expected a decrypt error, got none")
		}
	}
	if !found {
		t.Fatal("never saw the content entry")
	}
}

// encryptForTest mirrors app/src/services/crypto.ts's encrypt: a random
// 24-byte nonce prepended to the XChaCha20-Poly1305 sealed box — the
// inverse of this package's own decrypt.
func encryptForTest(plaintext, key []byte) ([]byte, error) {
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, nonceLength)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return aead.Seal(nonce, nonce, plaintext, nil), nil
}
