package fcm

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"circle-relay/internal/pushcredential"
)

// Placeholder is what a device shows when it cannot decrypt the payload —
// the extension failed, or the push was forged by someone without the
// circle's key. Deliberately says nothing: it names no circle, no person,
// and no activity.
//
// Devices hold their own copy and prefer it; this one only covers the case
// where the handler never runs at all and the platform renders the payload
// as it arrived.
const Placeholder = "New activity"

// Sender posts to FCM's HTTP v1 API.
type Sender struct {
	ProjectID string
	Client    *http.Client
	tokens    *tokenSource
}

// New builds a Sender from a loaded service-account key.
func New(account *pushcredential.ServiceAccount) *Sender {
	client := &http.Client{Timeout: 10 * time.Second}
	return &Sender{
		ProjectID: account.ProjectID,
		Client:    client,
		tokens:    &tokenSource{account: account, client: client},
	}
}

// Send delivers one notification to one device token.
//
// `data`, not `notification`: a data-only message hands the payload to the
// app's own handler, which decrypts it and writes the real text. A
// `notification` block would have the platform render whatever the relay
// said — and the relay cannot read the ciphertext it is forwarding.
//
// The placeholder rides alongside so the card is not blank when the
// handler doesn't run.
func (s *Sender) Send(ctx context.Context, deviceToken, pushRoutingID string, payload []byte) error {
	accessToken, err := s.tokens.accessToken(ctx)
	if err != nil {
		return err
	}

	body, err := json.Marshal(map[string]any{
		"message": map[string]any{
			"token": deviceToken,
			"data": map[string]string{
				// Which circle this belongs to, as far as the device is
				// concerned. It derives its own routing ids, so this is a
				// lookup key it already holds — the relay learns nothing by
				// naming it, and without it the device would have to
				// trial-decrypt against every circle it is in.
				"pushRoutingId": pushRoutingID,
				"payload":       base64.StdEncoding.EncodeToString(payload),
				"placeholder":   Placeholder,
			},
			"android": map[string]any{
				// High priority, or Doze defers a data-only message
				// indefinitely and a notification arrives hours late.
				"priority": "high",
			},
		},
	})
	if err != nil {
		return err
	}

	url := fmt.Sprintf("https://fcm.googleapis.com/v1/projects/%s/messages:send", s.ProjectID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.Client.Do(req)
	if err != nil {
		return fmt.Errorf("send push: %w", err)
	}
	defer resp.Body.Close()

	// The body can name the device token, so only the status is reported.
	// A 404 or 400 here usually means the token is stale; nothing prunes
	// them yet, and a dead token costs one failed send per notification.
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("send push: %s", resp.Status)
	}
	return nil
}
