// Loading the auth key this package signs its sends with.
//
// APNs takes a .p8 ES256 key plus a key id and team id, a different shape
// from FCM's single JSON blob (see internal/push/fcm/credential.go) — the
// file carries neither id, so they come from config instead.
package apns

import (
	"context"
	"fmt"
	"os"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
)

// AuthKey is what's needed to sign an APNs provider token.
type AuthKey struct {
	KeyID      string
	TeamID     string
	PrivateKey string // PEM, ES256 (.p8)
}

// Loader fetches the key once and keeps it — same reasoning as fcm.Loader:
// a Lambda serves many requests per cold start, and a failed first load
// shouldn't retry on every one of them.
type Loader struct {
	Client        *ssm.Client
	ParameterName string
	// FilePath, when set, is read instead of SSM — for running the relay
	// locally against LocalStack.
	FilePath string
	KeyID    string
	TeamID   string

	once sync.Once
	key  *AuthKey
	err  error
}

func (l *Loader) Load(ctx context.Context) (*AuthKey, error) {
	l.once.Do(func() {
		raw, err := l.read(ctx)
		if err != nil {
			l.err = err
			return
		}
		if l.KeyID == "" || l.TeamID == "" {
			l.err = fmt.Errorf("APNS_KEY_ID and APNS_TEAM_ID must both be set")
			return
		}
		l.key = &AuthKey{KeyID: l.KeyID, TeamID: l.TeamID, PrivateKey: string(raw)}
	})
	return l.key, l.err
}

func (l *Loader) read(ctx context.Context) ([]byte, error) {
	if l.FilePath != "" {
		raw, err := os.ReadFile(l.FilePath)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", l.FilePath, err)
		}
		return raw, nil
	}

	out, err := l.Client.GetParameter(ctx, &ssm.GetParameterInput{
		Name:           aws.String(l.ParameterName),
		WithDecryption: aws.Bool(true),
	})
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", l.ParameterName, err)
	}
	return []byte(aws.ToString(out.Parameter.Value)), nil
}
