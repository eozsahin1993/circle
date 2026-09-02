// Package dynamodb implements authstore.Store against its own "sessions"
// table — one item per bearer token, no sort key needed since a session
// is the only thing ever looked up by token (see
// server/provision/sessions_table.tf). Deliberately a different table
// from the account document (manifeststore): token-lookup and
// account-lookup are different access patterns, and sessions are
// ephemeral (TTL'd) where the account document isn't.
package dynamodb

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"circle-relay/internal/storage/authstore"
	"circle-relay/internal/storage/dynamoutil"
)

type Store struct {
	client    *dynamodb.Client
	tableName string
}

func New(client *dynamodb.Client, tableName string) *Store {
	return &Store{client: client, tableName: tableName}
}

var _ authstore.Store = (*Store)(nil)

func (s *Store) SaveSession(ctx context.Context, token string, session authstore.Session) error {
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

func (s *Store) GetSession(ctx context.Context, token string) (*authstore.Session, error) {
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
	return &authstore.Session{AccountID: accountID, ExpiresAt: time.Unix(expiresAt, 0)}, nil
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
