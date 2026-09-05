// Package dynamodb implements ratelimitstore.Store against a single
// "rate_limit" table shared by every configured Store instance (see
// server/provision/rate_limit_table.tf) — one item per (keyPrefix, key)
// pair, distinguished by prefixing the partition key rather than by a
// sort key, since nothing here is ever queried by range.
package dynamodb

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"circle-relay/internal/storage/dynamoutil"
	"circle-relay/internal/storage/ratelimitstore"
)

// nearLimitWarningThreshold is the fraction of a key's budget at which
// warnIfNearLimit logs.
const nearLimitWarningThreshold = 0.8

type Store struct {
	client      *dynamodb.Client
	tableName   string
	keyPrefix   string
	maxRequests int
	window      time.Duration
}

// New returns a Store scoped to one particular budget — keyPrefix
// ("write", "read", ...) keeps this instance's rows from ever colliding
// with, or being confused for, another instance's rows for the same
// caller-supplied key, even though they share one table.
func New(client *dynamodb.Client, tableName, keyPrefix string, maxRequests int, window time.Duration) *Store {
	return &Store{client: client, tableName: tableName, keyPrefix: keyPrefix, maxRequests: maxRequests, window: window}
}

var _ ratelimitstore.Store = (*Store)(nil)

// Allow is a two-attempt conditional UpdateItem, no preceding read (see
// ratelimitstore.Store's doc comment for why one Store is only ever one
// budget). Attempt 1 is the common case — increment within an active
// window. If it fails, the failure is ambiguous (expired window, or over
// budget); attempt 2 disambiguates by trying to reset instead, which only
// succeeds if the window really had expired.
func (s *Store) Allow(ctx context.Context, key string) (bool, error) {
	pk := s.keyPrefix + "#" + key
	now := dynamoutil.NowMillis()
	cutoff := now - s.window.Milliseconds()

	out, err := s.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: pk},
		},
		UpdateExpression:         aws.String("SET #c = #c + :one"),
		ConditionExpression:      aws.String("windowStart > :cutoff AND #c < :limit"),
		ExpressionAttributeNames: map[string]string{"#c": "count"},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":one":    &types.AttributeValueMemberN{Value: "1"},
			":cutoff": &types.AttributeValueMemberN{Value: strconv.FormatInt(cutoff, 10)},
			":limit":  &types.AttributeValueMemberN{Value: strconv.Itoa(s.maxRequests)},
		},
		ReturnValues: types.ReturnValueUpdatedNew,
	})
	if err == nil {
		if count, countErr := dynamoutil.AttrInt(out.Attributes, "count"); countErr == nil {
			s.warnIfNearLimit(pk, count)
		}
		return true, nil
	}
	var condFailed *types.ConditionalCheckFailedException
	if !errors.As(err, &condFailed) {
		return false, err
	}

	_, err = s.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: pk},
		},
		UpdateExpression:         aws.String("SET #c = :one, windowStart = :now"),
		ConditionExpression:      aws.String(fmt.Sprintf("attribute_not_exists(%s) OR windowStart <= :cutoff", dynamoutil.PKAttr)),
		ExpressionAttributeNames: map[string]string{"#c": "count"},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":one":    &types.AttributeValueMemberN{Value: "1"},
			":now":    &types.AttributeValueMemberN{Value: strconv.FormatInt(now, 10)},
			":cutoff": &types.AttributeValueMemberN{Value: strconv.FormatInt(cutoff, 10)},
		},
	})
	if err == nil {
		return true, nil
	}
	if errors.As(err, &condFailed) {
		// Attempt 1's failure wasn't the window, so it must have been the
		// budget — over the limit for a still-active window.
		return false, nil
	}
	return false, err
}

// warnIfNearLimit logs once a key's count crosses nearLimitWarningThreshold
// — the budget numbers are a starting guess, not a measurement, so this is
// how they'd get retuned from real traffic later.
func (s *Store) warnIfNearLimit(pk string, count int64) {
	if float64(count) >= float64(s.maxRequests)*nearLimitWarningThreshold {
		log.Printf("rate limit: %s is at %d/%d for this window", pk, count, s.maxRequests)
	}
}
