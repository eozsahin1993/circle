// Package dynamodb implements authstore.Store against its own DynamoDB
// table — deliberately separate from logstore's table (different field,
// different package): session state isn't circle-scoped data, see
// server/DESIGN.md's "Email auth" section.
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

// sessionSK is the only item kind this table holds — pk = token, since a
// session is looked up by the bearer token a client actually presents, not
// by email address.
const sessionSK = "#session"

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
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: sessionSK},
			"deviceId":        &types.AttributeValueMemberS{Value: session.DeviceID},
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
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: sessionSK},
		},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, err
	}
	if out.Item == nil {
		return nil, nil
	}
	deviceID, ok := dynamoutil.AttrString(out.Item, "deviceId")
	if !ok {
		return nil, errors.New("session item missing deviceId")
	}
	expiresAt, err := dynamoutil.AttrInt(out.Item, "expiresAt")
	if err != nil {
		return nil, err
	}
	return &authstore.Session{DeviceID: deviceID, ExpiresAt: time.Unix(expiresAt, 0)}, nil
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
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: sessionSK},
		},
	})
	return err
}
