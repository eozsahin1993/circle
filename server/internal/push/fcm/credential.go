// Loading the service-account key this package signs its sends with.
//
// FCM-specific despite reading from a generic place: APNs takes a .p8
// ES256 key plus a key id, team id and bundle id, which is a different
// shape entirely and will want its own loader under internal/push/apns.
//
// The SSM parameter is created by hand rather than by Terraform, because a
// Terraform-managed value ends up in state as plaintext. Nothing here
// writes it; this only reads.
package fcm

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
)

// Never wraps the underlying parse error: its message quotes the input,
// and the input is a private key.
func errNotAKey(parameterName string) error {
	return fmt.Errorf("%s is not a service-account key", parameterName)
}

// ServiceAccount is the subset of Google's key JSON needed to mint an
// access token. The file carries more; nothing else is read.
type ServiceAccount struct {
	ProjectID   string `json:"project_id"`
	ClientEmail string `json:"client_email"`
	PrivateKey  string `json:"private_key"`
	TokenURI    string `json:"token_uri"`
}

// Loader fetches the key once and keeps it, since a Lambda serves many
// requests per cold start and this costs a network call plus a KMS decrypt.
type Loader struct {
	Client        *ssm.Client
	ParameterName string
	// FilePath, when set, is read instead of SSM — for running the relay
	// locally against LocalStack, which has no parameter to read. Never set
	// in Lambda: a key on disk beside the code is the arrangement SSM
	// exists to avoid.
	FilePath string

	once sync.Once
	// Held rather than returned so a failed first load doesn't retry on
	// every request — a missing parameter is a deploy problem, not a
	// transient one, and hammering SSM won't fix it.
	account *ServiceAccount
	err     error
}

// Load returns the key, fetching it on first call.
//
// `WithDecryption` is what makes this a KMS operation: SSM performs the
// decrypt under the caller's identity, which is why the Lambda's policy
// needs kms:Decrypt even though nothing here imports a KMS client.
func (l *Loader) Load(ctx context.Context) (*ServiceAccount, error) {
	l.once.Do(func() {
		raw, err := l.read(ctx)
		if err != nil {
			l.err = err
			return
		}

		var account ServiceAccount
		if err := json.Unmarshal(raw, &account); err != nil {
			l.err = errNotAKey(l.source())
			return
		}
		if account.ProjectID == "" || account.ClientEmail == "" || account.PrivateKey == "" {
			l.err = fmt.Errorf("%s is missing project_id, client_email or private_key", l.source())
			return
		}

		l.account = &account
	})
	return l.account, l.err
}

func (l *Loader) source() string {
	if l.FilePath != "" {
		return l.FilePath
	}
	return l.ParameterName
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
