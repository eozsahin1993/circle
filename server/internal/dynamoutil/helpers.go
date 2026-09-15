// Package dynamoutil holds the handful of DynamoDB-attribute helpers shared
// by every DynamoDB-backed store (storage/logstore/dynamodb,
// storage/authstore/dynamodb) — split out so those two stay independent
// packages (different domains, genuinely separable) without duplicating
// this plumbing. Same category as internal/httputil: shared technology-
// specific plumbing, not a domain of its own.
package dynamoutil

import (
	"fmt"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Single-table design, shared shape across every store in this codebase:
// PK/SK attribute names, sort keys distinguishing item kinds.
const (
	PKAttr = "pk"
	SKAttr = "sk"
)

func NowMillis() int64 {
	return time.Now().UnixMilli()
}

// AttrInt reads a DynamoDB Number attribute out of an item as an int64.
func AttrInt(item map[string]types.AttributeValue, key string) (int64, error) {
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

// AttrString reads a DynamoDB String attribute out of an item, reporting
// whether it was present (rather than erroring) — callers that treat a
// missing attribute as a legitimate, skippable case want a bool, not an err.
func AttrString(item map[string]types.AttributeValue, key string) (string, bool) {
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

// AttrBytes reads a Binary attribute, reporting presence like AttrString.
func AttrBytes(item map[string]types.AttributeValue, key string) ([]byte, bool) {
	attr, ok := item[key]
	if !ok {
		return nil, false
	}
	b, ok := attr.(*types.AttributeValueMemberB)
	if !ok {
		return nil, false
	}
	return b.Value, true
}

// AttrBool reads a Boolean attribute. Missing reads as false: an item
// written before a flag existed hasn't opted into it.
func AttrBool(item map[string]types.AttributeValue, key string) bool {
	attr, ok := item[key].(*types.AttributeValueMemberBOOL)
	if !ok {
		return false
	}
	return attr.Value
}
