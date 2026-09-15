package dynamodb

import (
	"context"
	"errors"
	"fmt"
	"strconv"

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

func (s *Store) GetManifest(ctx context.Context, accountID string) (manifeststore.Manifest, error) {
	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: accountID},
		},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return manifeststore.Manifest{}, err
	}
	if out.Item == nil {
		return manifeststore.Manifest{}, nil
	}
	blobAttr, ok := out.Item["blob"].(*types.AttributeValueMemberB)
	if !ok {
		return manifeststore.Manifest{}, nil
	}

	// Absent version attribute reads as 0: every manifest written before
	// versioning has none, and those rows still have to be writable.
	var version int64
	if versionAttr, ok := out.Item["version"].(*types.AttributeValueMemberN); ok {
		if parsed, err := strconv.ParseInt(versionAttr.Value, 10, 64); err == nil {
			version = parsed
		}
	}
	return manifeststore.Manifest{Blob: blobAttr.Value, Version: version}, nil
}

func (s *Store) PutManifest(ctx context.Context, accountID string, blob []byte, expectedVersion int64) error {
	// Two ways to be at version 0 — no row at all, or a row predating the
	// version attribute — and a first write has to succeed against either.
	condition := "version = :expected"
	values := map[string]types.AttributeValue{
		":expected": &types.AttributeValueMemberN{Value: strconv.FormatInt(expectedVersion, 10)},
	}
	if expectedVersion == 0 {
		condition = fmt.Sprintf("attribute_not_exists(%s) OR attribute_not_exists(version)", dynamoutil.PKAttr)
		values = nil
	}

	_, err := s.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.tableName),
		Item: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: accountID},
			"blob":            &types.AttributeValueMemberB{Value: blob},
			"version":         &types.AttributeValueMemberN{Value: strconv.FormatInt(expectedVersion+1, 10)},
		},
		ConditionExpression:       aws.String(condition),
		ExpressionAttributeValues: values,
	})

	var condFailed *types.ConditionalCheckFailedException
	if errors.As(err, &condFailed) {
		return manifeststore.ErrVersionMismatch
	}
	return err
}

func (s *Store) DeleteManifest(ctx context.Context, accountID string) error {
	_, err := s.client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: accountID},
		},
	})
	return err
}
