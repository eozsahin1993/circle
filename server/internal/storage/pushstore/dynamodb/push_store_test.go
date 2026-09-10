package dynamodb_test

import (
	"context"
	"errors"
	"testing"

	"circle-relay/internal/storage/pushstore"
	"circle-relay/internal/testsupport"
)

func newStore(t *testing.T) pushstore.Store {
	t.Helper()
	return testsupport.NewPushStore(t)
}

func samplePrefs() pushstore.Prefs {
	return pushstore.Prefs{PushFanoutHash: []byte("thirty-two-bytes-of-hash-here!!!"), CategoryMask: 0b101, KeyVersion: 3}
}

func TestPrefsRoundTrip(t *testing.T) {
	store := newStore(t)
	pushRoutingID := testsupport.UniqueInviteTag(t)
	ctx := context.Background()

	if err := store.PutPrefs(ctx, pushRoutingID, samplePrefs()); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetPrefs(ctx, pushRoutingID)
	if err != nil {
		t.Fatal(err)
	}
	if string(got.PushFanoutHash) != string(samplePrefs().PushFanoutHash) {
		t.Fatalf("pushFanoutHash did not round-trip: %q", got.PushFanoutHash)
	}
	if got.CategoryMask != 0b101 || got.KeyVersion != 3 {
		t.Fatalf("expected mask 0b101 and version 3, got %b and %d", got.CategoryMask, got.KeyVersion)
	}
}

func TestGetPrefsUnregistered(t *testing.T) {
	store := newStore(t)

	_, err := store.GetPrefs(context.Background(), testsupport.UniqueInviteTag(t))
	if !errors.Is(err, pushstore.ErrPushRoutingNotFound) {
		t.Fatalf("expected ErrPushRoutingNotFound, got %v", err)
	}
}

// A rotation rewrites prefs in place; the old hash must not survive.
func TestPutPrefsReplaces(t *testing.T) {
	store := newStore(t)
	pushRoutingID := testsupport.UniqueInviteTag(t)
	ctx := context.Background()

	if err := store.PutPrefs(ctx, pushRoutingID, samplePrefs()); err != nil {
		t.Fatal(err)
	}
	rotated := pushstore.Prefs{PushFanoutHash: []byte("a-completely-different-hash-here"), CategoryMask: 0b1, KeyVersion: 4}
	if err := store.PutPrefs(ctx, pushRoutingID, rotated); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetPrefs(ctx, pushRoutingID)
	if err != nil {
		t.Fatal(err)
	}
	if string(got.PushFanoutHash) != string(rotated.PushFanoutHash) || got.KeyVersion != 4 {
		t.Fatalf("expected the rotated prefs, got version %d", got.KeyVersion)
	}
}

func TestDevicesRoundTrip(t *testing.T) {
	store := newStore(t)
	pushRoutingID := testsupport.UniqueInviteTag(t)
	ctx := context.Background()

	phone := pushstore.Device{DeviceID: "phone", PushToken: []byte("enc-phone"), Platform: "ios", Enabled: true}
	tablet := pushstore.Device{DeviceID: "tablet", PushToken: []byte("enc-tablet"), Platform: "android", Enabled: false}
	for _, device := range []pushstore.Device{phone, tablet} {
		if err := store.PutDevice(ctx, pushRoutingID, device); err != nil {
			t.Fatal(err)
		}
	}

	devices, err := store.ListDevices(ctx, pushRoutingID)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 2 {
		t.Fatalf("expected 2 devices, got %d", len(devices))
	}

	byID := map[string]pushstore.Device{}
	for _, device := range devices {
		byID[device.DeviceID] = device
	}
	if got := byID["phone"]; string(got.PushToken) != "enc-phone" || got.Platform != "ios" || !got.Enabled {
		t.Fatalf("phone did not round-trip: %+v", got)
	}
	// Disabled rows come back too, so a caller can tell "no devices" from
	// "all muted" without a second read.
	if got := byID["tablet"]; got.Enabled {
		t.Fatalf("tablet should have come back disabled: %+v", got)
	}
}

// The device rows and the prefs row share a partition, so a bug in the
// sort-key prefix would have ListDevices return the prefs row as a device.
func TestListDevicesExcludesPrefsRow(t *testing.T) {
	store := newStore(t)
	pushRoutingID := testsupport.UniqueInviteTag(t)
	ctx := context.Background()

	if err := store.PutPrefs(ctx, pushRoutingID, samplePrefs()); err != nil {
		t.Fatal(err)
	}

	devices, err := store.ListDevices(ctx, pushRoutingID)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 0 {
		t.Fatalf("expected no devices, got %+v", devices)
	}
}

func TestListDevicesIsScopedToItsRoutingID(t *testing.T) {
	store := newStore(t)
	mine, theirs := testsupport.UniqueInviteTag(t), testsupport.UniqueInviteTag(t)
	ctx := context.Background()

	if err := store.PutDevice(ctx, theirs, pushstore.Device{DeviceID: "d", PushToken: []byte("t"), Enabled: true}); err != nil {
		t.Fatal(err)
	}

	devices, err := store.ListDevices(ctx, mine)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 0 {
		t.Fatalf("another routing id's devices leaked in: %+v", devices)
	}
}

func TestDeleteDevice(t *testing.T) {
	store := newStore(t)
	pushRoutingID := testsupport.UniqueInviteTag(t)
	ctx := context.Background()

	if err := store.PutDevice(ctx, pushRoutingID, pushstore.Device{DeviceID: "phone", PushToken: []byte("t"), Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteDevice(ctx, pushRoutingID, "phone"); err != nil {
		t.Fatal(err)
	}

	devices, err := store.ListDevices(ctx, pushRoutingID)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 0 {
		t.Fatalf("expected the device gone, got %+v", devices)
	}

	// Idempotent: unregistering twice is a normal retry.
	if err := store.DeleteDevice(ctx, pushRoutingID, "phone"); err != nil {
		t.Fatalf("deleting an absent device should succeed: %v", err)
	}
}

func TestDeleteRoutingRemovesPrefsAndDevices(t *testing.T) {
	store := newStore(t)
	pushRoutingID := testsupport.UniqueInviteTag(t)
	ctx := context.Background()

	if err := store.PutPrefs(ctx, pushRoutingID, samplePrefs()); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"phone", "tablet"} {
		if err := store.PutDevice(ctx, pushRoutingID, pushstore.Device{DeviceID: id, PushToken: []byte("t"), Enabled: true}); err != nil {
			t.Fatal(err)
		}
	}

	if err := store.DeleteRouting(ctx, pushRoutingID); err != nil {
		t.Fatal(err)
	}

	if _, err := store.GetPrefs(ctx, pushRoutingID); !errors.Is(err, pushstore.ErrPushRoutingNotFound) {
		t.Fatalf("expected the prefs row gone, got %v", err)
	}
	devices, err := store.ListDevices(ctx, pushRoutingID)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 0 {
		t.Fatalf("expected every device row gone, got %+v", devices)
	}

	if err := store.DeleteRouting(ctx, pushRoutingID); err != nil {
		t.Fatalf("deleting absent routing should succeed: %v", err)
	}
}

// Silencing must not disturb the hash or categories, so unsilencing needs
// no content key.
func TestSetSilencedLeavesTheRestAlone(t *testing.T) {
	store := newStore(t)
	pushRoutingID := testsupport.UniqueInviteTag(t)
	ctx := context.Background()

	if err := store.PutPrefs(ctx, pushRoutingID, samplePrefs()); err != nil {
		t.Fatal(err)
	}
	if err := store.SetSilenced(ctx, pushRoutingID, true); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetPrefs(ctx, pushRoutingID)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Silenced {
		t.Fatal("expected the row silenced")
	}
	if string(got.PushFanoutHash) != string(samplePrefs().PushFanoutHash) || got.CategoryMask != 0b101 {
		t.Fatalf("silencing disturbed the rest of the row: %+v", got)
	}

	if err := store.SetSilenced(ctx, pushRoutingID, false); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.GetPrefs(ctx, pushRoutingID); got.Silenced {
		t.Fatal("expected the row unsilenced")
	}
}

func TestSetSilencedUnregistered(t *testing.T) {
	store := newStore(t)

	err := store.SetSilenced(context.Background(), testsupport.UniqueInviteTag(t), true)
	if !errors.Is(err, pushstore.ErrPushRoutingNotFound) {
		t.Fatalf("expected ErrPushRoutingNotFound, got %v", err)
	}
}

// Registering a rotated push token must not restate the account's
// categories — the two rows are written independently on purpose.
func TestPutDeviceLeavesPrefsAlone(t *testing.T) {
	store := newStore(t)
	pushRoutingID := testsupport.UniqueInviteTag(t)
	ctx := context.Background()

	if err := store.PutPrefs(ctx, pushRoutingID, samplePrefs()); err != nil {
		t.Fatal(err)
	}
	if err := store.PutDevice(ctx, pushRoutingID, pushstore.Device{DeviceID: "phone", PushToken: []byte("t"), Enabled: true}); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetPrefs(ctx, pushRoutingID)
	if err != nil {
		t.Fatal(err)
	}
	if got.CategoryMask != 0b101 {
		t.Fatalf("expected the mask untouched, got %b", got.CategoryMask)
	}
}
