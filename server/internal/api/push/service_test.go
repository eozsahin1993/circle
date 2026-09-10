package push

import (
	"context"
	"errors"
	"testing"

	"circle-relay/internal/storage/pushstore"
)

// fakeStore drives Fanout's decisions without LocalStack.
type fakeStore struct {
	prefs   map[string]pushstore.Prefs
	devices map[string][]pushstore.Device
	// Proves a rejected target never reached the second read.
	listCalls int
	err       error
}

func (f *fakeStore) PutPrefs(context.Context, string, pushstore.Prefs) error { return nil }

func (f *fakeStore) GetPrefs(_ context.Context, routingID string) (*pushstore.Prefs, error) {
	if f.err != nil {
		return nil, f.err
	}
	prefs, ok := f.prefs[routingID]
	if !ok {
		return nil, pushstore.ErrRoutingNotFound
	}
	return &prefs, nil
}

func (f *fakeStore) PutDevice(context.Context, string, pushstore.Device) error { return nil }

func (f *fakeStore) ListDevices(_ context.Context, routingID string) ([]pushstore.Device, error) {
	f.listCalls++
	return f.devices[routingID], nil
}

func (f *fakeStore) DeleteDevice(context.Context, string, string) error { return nil }
func (f *fakeStore) DeleteRouting(context.Context, string) error        { return nil }

// countingLimit records its keys, to assert budget is charged only after
// verification.
type countingLimit struct {
	keys  []string
	allow bool
}

func (c *countingLimit) Allow(_ context.Context, key string) (bool, error) {
	c.keys = append(c.keys, key)
	return c.allow, nil
}

const token = "fanout-token"

func newService(t *testing.T, limit *countingLimit) (*Service, *fakeStore) {
	t.Helper()
	store := &fakeStore{
		prefs: map[string]pushstore.Prefs{
			"routing-a": {FanoutHash: FanoutHash([]byte(token), "routing-a"), CategoryMask: 0b011},
			"routing-b": {FanoutHash: FanoutHash([]byte(token), "routing-b"), CategoryMask: 0b011},
		},
		devices: map[string][]pushstore.Device{
			"routing-a": {{DeviceID: "d1", PushToken: []byte("t1"), Platform: "ios", Enabled: true}},
			"routing-b": {{DeviceID: "d2", PushToken: []byte("t2"), Platform: "android", Enabled: true}},
		},
	}
	return &Service{PushStore: store, RecipientLimit: limit}, store
}

func TestFanout_DeliversToVerifiedTargets(t *testing.T) {
	service, _ := newService(t, &countingLimit{allow: true})

	result, err := service.Fanout(context.Background(), []string{"routing-a", "routing-b"}, []byte(token), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deliveries) != 2 || result.Skipped != 0 {
		t.Fatalf("expected 2 deliveries and 0 skipped, got %d and %d", len(result.Deliveries), result.Skipped)
	}
}

// What the salted hash is for: another circle's member holds a different
// token, so naming your routing ids gets them nothing.
func TestFanout_WrongTokenDeliversNothing(t *testing.T) {
	service, _ := newService(t, &countingLimit{allow: true})

	result, err := service.Fanout(context.Background(), []string{"routing-a"}, []byte("some-other-circles-token"), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deliveries) != 0 || result.Skipped != 1 {
		t.Fatalf("expected the target skipped, got %d deliveries", len(result.Deliveries))
	}
}

// A hash valid for one routing id must not verify for another.
func TestFanout_HashIsBoundToItsRoutingID(t *testing.T) {
	service, store := newService(t, &countingLimit{allow: true})
	// Give routing-b the hash that belongs to routing-a.
	store.prefs["routing-b"] = pushstore.Prefs{
		FanoutHash:   FanoutHash([]byte(token), "routing-a"),
		CategoryMask: 0b011,
	}

	result, err := service.Fanout(context.Background(), []string{"routing-b"}, []byte(token), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deliveries) != 0 {
		t.Fatalf("a hash bound to another routing id must not verify, got %d deliveries", len(result.Deliveries))
	}
}

func TestFanout_UnregisteredTargetIsSkippedNotFatal(t *testing.T) {
	service, _ := newService(t, &countingLimit{allow: true})

	result, err := service.Fanout(context.Background(), []string{"never-registered", "routing-a"}, []byte(token), 0)
	if err != nil {
		t.Fatalf("an unknown routing id must not fail the whole send: %v", err)
	}
	if len(result.Deliveries) != 1 || result.Skipped != 1 {
		t.Fatalf("expected 1 delivered and 1 skipped, got %d and %d", len(result.Deliveries), result.Skipped)
	}
}

func TestFanout_DisabledCategoryIsSkipped(t *testing.T) {
	service, _ := newService(t, &countingLimit{allow: true})

	// Bits 0 and 1 are set; 2 is not.
	result, err := service.Fanout(context.Background(), []string{"routing-a"}, []byte(token), 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deliveries) != 0 {
		t.Fatalf("expected the disabled category skipped, got %d deliveries", len(result.Deliveries))
	}
}

func TestFanout_DisabledDeviceGetsNothing(t *testing.T) {
	service, store := newService(t, &countingLimit{allow: true})
	store.devices["routing-a"] = []pushstore.Device{{DeviceID: "d1", PushToken: []byte("t1"), Enabled: false}}

	result, err := service.Fanout(context.Background(), []string{"routing-a"}, []byte(token), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deliveries) != 0 || result.Skipped != 1 {
		t.Fatalf("a muted device must not be delivered to, got %d deliveries", len(result.Deliveries))
	}
}

// One recipient's budget must not silence the rest of the circle.
func TestFanout_OverBudgetSkipsOnlyThatRecipient(t *testing.T) {
	limit := &countingLimit{allow: false}
	service, _ := newService(t, limit)

	result, err := service.Fanout(context.Background(), []string{"routing-a", "routing-b"}, []byte(token), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deliveries) != 0 || result.Skipped != 2 {
		t.Fatalf("expected both skipped on budget, got %d delivered", len(result.Deliveries))
	}
	if len(limit.keys) != 2 {
		t.Fatalf("expected the budget keyed per recipient, got keys %v", limit.keys)
	}
}

// The ordering that keeps the limiter from becoming the amplification:
// an unverified target must never reach the budget.
func TestFanout_UnverifiedTargetsNeverConsumeBudget(t *testing.T) {
	limit := &countingLimit{allow: true}
	service, store := newService(t, limit)

	_, err := service.Fanout(context.Background(), []string{"never-registered", "routing-a"}, []byte("wrong-token"), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(limit.keys) != 0 {
		t.Fatalf("no budget should be consumed by unverified targets, got %v", limit.keys)
	}
	if store.listCalls != 0 {
		t.Fatalf("no device read should happen for unverified targets, got %d", store.listCalls)
	}
}

func TestFanout_RejectsTooManyTargets(t *testing.T) {
	service, _ := newService(t, &countingLimit{allow: true})

	targets := make([]string, MaxFanoutTargets+1)
	for i := range targets {
		targets[i] = "routing-a"
	}

	_, err := service.Fanout(context.Background(), targets, []byte(token), 0)
	if !errors.Is(err, ErrTooManyTargets) {
		t.Fatalf("expected ErrTooManyTargets, got %v", err)
	}
}

func TestFanout_StorageFailureIsFatal(t *testing.T) {
	service, store := newService(t, &countingLimit{allow: true})
	store.err = errors.New("dynamodb is down")

	if _, err := service.Fanout(context.Background(), []string{"routing-a"}, []byte(token), 0); err == nil {
		t.Fatal("a storage failure must not be reported as a silently skipped target")
	}
}

func TestPackCategories(t *testing.T) {
	mask, err := packCategories([]int64{0, 2, 5})
	if err != nil {
		t.Fatal(err)
	}
	if mask != 0b100101 {
		t.Fatalf("expected 0b100101, got %b", mask)
	}

	if _, err := packCategories([]int64{-1}); err == nil {
		t.Fatal("expected a negative category to be rejected")
	}
	if _, err := packCategories([]int64{MaxCategory + 1}); err == nil {
		t.Fatal("expected an out-of-range category to be rejected")
	}
}
