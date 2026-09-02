package dynamodb

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"circle-relay/internal/storage/dynamoutil"
	"circle-relay/internal/storage/manifeststore"
)

type Store struct {
	client    *dynamodb.Client
	tableName string
}

func New(client *dynamodb.Client, tableName string) *Store {
	return &Store{client: client, tableName: tableName}
}

var _ manifeststore.Store = (*Store)(nil)

func (s *Store) GetManifest(ctx context.Context, accountID string) ([]byte, error) {
	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: accountID},
		},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, err
	}
	if out.Item == nil {
		return nil, nil
	}
	blobAttr, ok := out.Item["blob"].(*types.AttributeValueMemberB)
	if !ok {
		return nil, nil
	}
	return blobAttr.Value, nil
}

func (s *Store) PutManifest(ctx context.Context, accountID string, blob []byte) error {
	_, err := s.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.tableName),
		Item: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: accountID},
			"blob":            &types.AttributeValueMemberB{Value: blob},
		},
	})
	return err
}
