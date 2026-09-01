package dynamodb

import (
	"fmt"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

func nowMillis() int64 {
	return time.Now().UnixMilli()
}

// attrInt reads a DynamoDB Number attribute out of an item as an int64.
func attrInt(item map[string]types.AttributeValue, key string) (int64, error) {
	attr, ok := item[key]
	if !ok {
		return 0, fmt.Errorf("missing attribute %q", key)
	}
	n, ok := attr.(*types.AttributeValueMemberN)
	if !ok {
		return 0, fmt.Errorf("attribute %q is not a number", key)
	}
	value, err := strconv.ParseInt(n.Value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("attribute %q is not a valid integer: %w", key, err)
	}
	return value, nil
}

// attrString reads a DynamoDB String attribute out of an item, reporting
// whether it was present (rather than erroring) — callers that treat a
// missing attribute as a legitimate, skippable case want a bool, not an err.
func attrString(item map[string]types.AttributeValue, key string) (string, bool) {
	attr, ok := item[key]
	if !ok {
		return "", false
	}
	s, ok := attr.(*types.AttributeValueMemberS)
	if !ok {
		return "", false
	}
	return s.Value, true
}
