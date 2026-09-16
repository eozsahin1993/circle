package dynamodb

import (
	"context"
	"errors"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/synclog"
	"mimoza-relay/internal/util/dynamoutil"
)

type controlState struct {
	authoritySet   map[string]bool
	writeTokenHash string
	metaCounter    int64
	contentCounter int64
	deleted        bool
}

func (c *controlState) counter(ns synclog.Namespace) int64 {
	if ns == synclog.NamespaceContent {
		return c.contentCounter
	}
	return c.metaCounter
}

// getControlState is the read half of the compare-and-swap every
// casCommit attempt runs — a separate read because TransactWriteItems's
// Update can't hand back the value it just wrote, so the *next* value is
// computed from a read beforehand and the transaction re-checks nothing
// moved in between.
func (s *Store) getControlState(ctx context.Context, syncID string, consistent bool) (*controlState, error) {
	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(s.tableName),
		Key:            controlKey(syncID),
		ConsistentRead: aws.Bool(consistent),
	})
	if err != nil {
		return nil, err
	}
	if out.Item == nil {
		return nil, synclog.ErrCircleNotFound
	}

	authoritySet := map[string]bool{}
	if attr, ok := out.Item["authoritySet"].(*types.AttributeValueMemberSS); ok {
		for _, key := range attr.Value {
			authoritySet[key] = true
		}
	}
	writeTokenHash, _ := dynamoutil.AttrString(out.Item, "writeTokenHash")
	epochs, err := parseControlEpochs(out.Item)
	if err != nil {
		return nil, err
	}
	_, deleted := out.Item["deletedAt"]
	return &controlState{
		authoritySet:   authoritySet,
		writeTokenHash: writeTokenHash,
		metaCounter:    epochs.Meta,
		contentCounter: epochs.Content,
		deleted:        deleted,
	}, nil
}

// parseControlEpochs reads just the two counters off a #control item —
// shared by getControlState (which also needs the rest of the item) and
// Peek (which needs only this).
func parseControlEpochs(item map[string]types.AttributeValue) (synclog.Epochs, error) {
	metaCounter, err := dynamoutil.AttrInt(item, "metaCounter")
	if err != nil {
		return synclog.Epochs{}, err
	}
	contentCounter, err := dynamoutil.AttrInt(item, "contentCounter")
	if err != nil {
		return synclog.Epochs{}, err
	}
	return synclog.Epochs{Meta: metaCounter, Content: contentCounter}, nil
}

// Bootstrap is a plain conditional PutItem — the founder's own
// member_added entry is a separate, subsequent Append call using the
// write token this registers.
func (s *Store) Bootstrap(ctx context.Context, syncID, founderAuthorityPublicKey, initialWriteTokenHash string) error {
	_, err := s.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.tableName),
		Item: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: syncID},
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: controlSK},
			"authoritySet":    &types.AttributeValueMemberSS{Value: []string{founderAuthorityPublicKey}},
			"writeTokenHash":  &types.AttributeValueMemberS{Value: initialWriteTokenHash},
			"metaCounter":     &types.AttributeValueMemberN{Value: "0"},
			"contentCounter":  &types.AttributeValueMemberN{Value: "0"},
		},
		ConditionExpression: aws.String(fmt.Sprintf("attribute_not_exists(%s)", dynamoutil.PKAttr)),
	})
	if err != nil {
		var condFailed *types.ConditionalCheckFailedException
		if errors.As(err, &condFailed) {
			return synclog.ErrAlreadyExists
		}
		return err
	}
	return nil
}
