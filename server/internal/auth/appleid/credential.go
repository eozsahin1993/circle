// Loading the Sign in with Apple key this package signs client secrets
// with — the same .p8-from-SSM shape as internal/push/apns/credential.go,
// but a different key: APNs keys and Sign in with Apple keys are separate
// key types in the developer portal and are not interchangeable.
package appleid

import (
	"context"
	"fmt"
	"os"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
)

// Loader fetches the key once and keeps it, same reasoning as
// apns.Loader: a Lambda serves many requests per cold start, and a failed
// first load shouldn't retry on every one of them.
type Loader struct {
	Client        *ssm.Client
	ParameterName string
	// FilePath, when set, is read instead of SSM — for running the relay
	// locally against LocalStack.
	FilePath string
	KeyID    string
	TeamID   string
	ClientID string

	once sync.Once
	key  Key
	err  error
}

func (l *Loader) Load(ctx context.Context) (Key, error) {
	l.once.Do(func() {
		raw, err := l.read(ctx)
		if err != nil {
			l.err = err
			return
		}
		l.key = Key{KeyID: l.KeyID, TeamID: l.TeamID, ClientID: l.ClientID, PrivateKey: string(raw)}
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

// NewClient returns the Client the relay uses in anger, or nil when Sign
// in with Apple revocation isn't configured for this environment. Nil is
// a supported state everywhere it's wired: sign-in and deletion both keep
// working, they just don't touch Apple's grant.
func NewClient(awsCfg aws.Config, parameterName, filePath, keyID, teamID, clientID string) *Client {
	if keyID == "" || teamID == "" || clientID == "" {
		return nil
	}
	loader := &Loader{
		Client:        ssm.NewFromConfig(awsCfg),
		ParameterName: parameterName,
		FilePath:      filePath,
		KeyID:         keyID,
		TeamID:        teamID,
		ClientID:      clientID,
	}
	return &Client{LoadKey: loader.Load}
}
