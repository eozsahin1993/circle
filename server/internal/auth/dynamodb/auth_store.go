// Package dynamodb implements auth.Store against its own "sessions"
// table — one item per bearer token, no sort key needed since a session
// is looked up by token for every path except account deletion (see
// server/provision/sessions_table.tf, and its accountId-index GSI).
// Deliberately a different table from the account document
// (account): token-lookup and account-lookup are different access
// patterns, and sessions are ephemeral (TTL'd) where the account document
// isn't.
package dynamodb

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"circle-relay/internal/auth"
	"circle-relay/internal/util/dynamoutil"
)

type Store struct {
	client    *dynamodb.Client
	tableName string
}

func New(client *dynamodb.Client, tableName string) *Store {
	return &Store{client: client, tableName: tableName}
}

var _ auth.Store = (*Store)(nil)

func (s *Store) SaveSession(ctx context.Context, token string, session auth.Session) error {
	_, err := s.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.tableName),
		Item: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: token},
			"accountId":       &types.AttributeValueMemberS{Value: session.AccountID},
			"expiresAt":       &types.AttributeValueMemberN{Value: strconv.FormatInt(session.ExpiresAt.Unix(), 10)},
		},
	})
	return err
}

func (s *Store) GetSession(ctx context.Context, token string) (*auth.Session, error) {
	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: token},
		},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, err
	}
	if out.Item == nil {
		return nil, nil
	}
	accountID, ok := dynamoutil.AttrString(out.Item, "accountId")
	if !ok {
		return nil, errors.New("session item missing accountId")
	}
	expiresAt, err := dynamoutil.AttrInt(out.Item, "expiresAt")
	if err != nil {
		return nil, err
	}
	return &auth.Session{AccountID: accountID, ExpiresAt: time.Unix(expiresAt, 0)}, nil
}

// DeleteSession revokes token immediately — logout, or responding to a
// suspected leak, without waiting out the session's natural TTL. Deleting
// an already-gone item is a no-op in DynamoDB, so this is safely callable
// even for a token that doesn't exist or already expired.
func (s *Store) DeleteSession(ctx context.Context, token string) error {
	_, err := s.client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: token},
		},
	})
	return err
}

// AccountIDIndexName is the GSI DeleteAllSessions queries to find every
// session for an account — see provision/sessions_table.tf. Exported so
// internal/util/localstack can create it under the same name in tests.
const AccountIDIndexName = "accountId-index"

// deleteAllSessionsPasses: the GSI is only eventually consistent, so a
// session saved moments before this runs (a second device signing in
// right as the first deletes the account) can miss the first pass.
// Sweeping a few times with a growing wait between closes that window;
// a pass that finds nothing to delete is cheap, so repeating it costs
// little even when nothing was missed. Same shape as findEntryByID's own
// GSI-lag retry (dynamoutil doesn't export sleepBackoff — small enough to
// repeat here rather than reach across an unrelated storage package for).
const deleteAllSessionsPasses = 8

func deleteAllSessionsBackoff(ctx context.Context, attempt int) error {
	delay := 100 * time.Millisecond << (attempt - 1)
	if delay > 2*time.Second {
		delay = 2 * time.Second
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// DeleteAllSessions finds every session for accountID via the GSI, then
// deletes each by its token — an account can have as many sessions as it
// has signed-in devices, small enough that a plain per-item delete needs
// no batching. Deliberately does not stop early once a pass finds
// nothing: a session the GSI hasn't caught up on yet also looks like "no
// session," so an empty pass can't be told apart from a real one — only
// exhausting the full budget gives a slow-to-propagate session every
// chance to show up before this gives up on it.
func (s *Store) DeleteAllSessions(ctx context.Context, accountID string) error {
	for pass := 0; pass < deleteAllSessionsPasses; pass++ {
		if pass > 0 {
			if err := deleteAllSessionsBackoff(ctx, pass); err != nil {
				return err
			}
		}
		if err := s.deleteSessionsForAccountOnce(ctx, accountID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) deleteSessionsForAccountOnce(ctx context.Context, accountID string) error {
	paginator := dynamodb.NewQueryPaginator(s.client, &dynamodb.QueryInput{
		TableName:              aws.String(s.tableName),
		IndexName:              aws.String(AccountIDIndexName),
		KeyConditionExpression: aws.String("accountId = :accountId"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":accountId": &types.AttributeValueMemberS{Value: accountID},
		},
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return err
		}
		for _, item := range page.Items {
			token, ok := dynamoutil.AttrString(item, dynamoutil.PKAttr)
			if !ok {
				continue
			}
			if err := s.DeleteSession(ctx, token); err != nil {
				return err
			}
		}
	}
	return nil
}
