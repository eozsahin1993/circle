// Package dynamodb implements synclog.LogStore against a single DynamoDB
// table, one partition per syncID. See internal/synclog's package doc
// for the two capabilities (write token, authority signature) this
// enforces.
package dynamodb

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/synclog"
	"mimoza-relay/internal/util/dynamoutil"
)

// readPageSize caps how many entries a single Read call returns — an
// internal server policy, not a client-controllable parameter. A caller
// that needs more just calls again with `since` advanced to the epoch of
// the last entry it actually received (never to CurrentEpoch — a capped
// page means CurrentEpoch is still ahead of what was actually returned).
const readPageSize = 200

// peekRetryBaseDelay/peekRetryMaxDelay bound the backoff between Peek's
// UnprocessedKeys retries — small, because a poll endpoint that stalls is
// worse than one that returns a partial-batch error the client retries on
// its own cadence.
const (
	peekRetryBaseDelay = 20 * time.Millisecond
	peekRetryMaxDelay  = 200 * time.Millisecond
)

// maxCASAttempts bounds the compare-and-swap retry loop Append and Rotate
// use to keep "check the token/authority" and "bump the counter" atomic
// (see getControlState). Retries only happen under genuine concurrent
// writes to the same circle — vanishingly rare at family-circle scale.
const maxCASAttempts = 5

// EntryIDIndexName is the GSI DeleteEntry queries to find a post by id —
// see modules/storage/dynamodb.tf. Exported so internal/util/localstack can
// create it under the same name in tests.
const EntryIDIndexName = "entryId-index"

// batchWriteSize is DynamoDB's own hard cap on items per BatchWriteItem —
// not a tuning knob. A larger request is rejected outright.
const batchWriteSize = 25

// sweepConcurrency bounds how many delete batches are in flight at once.
// Bounded rather than unlimited because the throughput this buys is the
// same throughput that trips throttling — batchDelete already backs off
// on UnprocessedItems, and a wide fan-out would just spend the budget
// faster and then wait longer.
const sweepConcurrency = 8

// idemMarkerTTL is a short, fixed retry window — deliberately not tied to
// any product retention setting (entries and #control never expire; see
// invariant 1). A marker's only job is making a same-entryID retry
// converge shortly after the original commit.
const idemMarkerTTL = 48 * time.Hour

// Single-table design: PK = syncID, SK distinguishes item kinds, epoch
// zero-padded to preserve numeric ordering lexicographically. The four SK
// shapes never collide: "#control" sorts before both namespace prefixes,
// and "idem#<ns>#..." sorts strictly outside either namespace's entry
// range.
const (
	controlSK  = "#control"
	epochWidth = 12 // supports up to 999,999,999,999 entries per namespace — generous past any real use.
)

func entrySK(ns synclog.Namespace, epoch int64) string {
	return fmt.Sprintf("%s#%0*d", ns, epochWidth, epoch)
}

// entrySKUpperBound sorts after any real entry key in ns, for range
// queries.
func entrySKUpperBound(ns synclog.Namespace) string {
	max := ""
	for i := 0; i < epochWidth; i++ {
		max += "9"
	}
	return string(ns) + "#" + max
}

func idemSK(ns synclog.Namespace, entryID string) string {
	return "idem#" + string(ns) + "#" + entryID
}

func counterAttrName(ns synclog.Namespace) string {
	if ns == synclog.NamespaceContent {
		return "contentCounter"
	}
	return "metaCounter"
}

type Store struct {
	client    *dynamodb.Client
	tableName string
}

func New(client *dynamodb.Client, tableName string) *Store {
	return &Store{client: client, tableName: tableName}
}

var _ synclog.LogStore = (*Store)(nil)

func controlKey(syncID string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{
		dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: syncID},
		dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: controlSK},
	}
}

// sleepBackoff waits out one retry of an exponential backoff, or returns
// early if ctx is cancelled first — a request that's already given up
// shouldn't hold the invocation open sleeping.
func sleepBackoff(ctx context.Context, attempt int) error {
	// Doubles per attempt: 20ms, 40ms, 80ms, ... capped at peekRetryMaxDelay.
	// Shift width is clamped — an unbounded shift on a sustained-throttling
	// caller (Peek, batchDelete) would eventually overflow int64 and wrap
	// the delay to near-zero, silently defeating the cap it's supposed to hit.
	delay := peekRetryMaxDelay
	if shift := attempt - 1; shift >= 0 && shift < 32 {
		if d := peekRetryBaseDelay << shift; d < peekRetryMaxDelay {
			delay = d
		}
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
