// Package pushcredential loads the FCM service-account key the relay signs
// its sends with — see server/PUSH_DESIGN.md.
//
// The parameter is created by hand rather than by Terraform, because a
// Terraform-managed value ends up in state as plaintext. Nothing here
// writes it; this only reads.
package pushcredential

import (
	"context"
	"encoding/json"
	"fmt"
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
		out, err := l.Client.GetParameter(ctx, &ssm.GetParameterInput{
			Name:           aws.String(l.ParameterName),
			WithDecryption: aws.Bool(true),
		})
		if err != nil {
			l.err = fmt.Errorf("read %s: %w", l.ParameterName, err)
			return
		}

		var account ServiceAccount
		if err := json.Unmarshal([]byte(aws.ToString(out.Parameter.Value)), &account); err != nil {
			l.err = errNotAKey(l.ParameterName)
			return
		}
		if account.ProjectID == "" || account.ClientEmail == "" || account.PrivateKey == "" {
			l.err = fmt.Errorf("%s is missing project_id, client_email or private_key", l.ParameterName)
			return
		}

		l.account = &account
	})
	return l.account, l.err
}
