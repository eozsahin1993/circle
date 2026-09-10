// Package pushstore defines the interface domain logic depends on for push
// routing state — see server/PUSH_DESIGN.md.
//
// No account ids, circle ids, or lists of which routing ids belong
// together, anywhere in here. There is deliberately no method that could
// write one.
package pushstore

import (
	"context"
	"errors"
)

// ErrPushRoutingNotFound means a routing id has no prefs row. Distinct from a
// storage failure so a send to a stale id skips rather than fails.
var ErrPushRoutingNotFound = errors.New("pushstore: routing id not registered")

// Prefs is one routing id's control row.
type Prefs struct {
	PushFanoutHash []byte
	// Enabled-bits, not disabled: a row written before a category existed
	// has that bit unset, so a new category stays off until the device
	// re-registers rather than switching itself on for everyone.
	CategoryMask int64
	// Never compared during a send — the hash is what authorizes.
	KeyVersion int64
}

// Device is one device's delivery row. PushToken arrives already
// encrypted; nothing here encrypts or decrypts.
type Device struct {
	DeviceID  string
	PushToken []byte
	Platform  string
	Enabled   bool
}

// Store persists one prefs row per routing id, plus a device row per
// device wanting delivery under it.
type Store interface {
	PutPrefs(ctx context.Context, pushRoutingID string, prefs Prefs) error
	GetPrefs(ctx context.Context, pushRoutingID string) (*Prefs, error)
	// Independent of PutPrefs: re-registering a rotated push token must not
	// restate the account's categories.
	PutDevice(ctx context.Context, pushRoutingID string, device Device) error
	// Returns disabled rows too — a caller can then tell "no devices" from
	// "all muted" without a second read.
	ListDevices(ctx context.Context, pushRoutingID string) ([]Device, error)
	DeleteDevice(ctx context.Context, pushRoutingID, deviceID string) error
	// Prefs and every device row with it. Idempotent.
	DeleteRouting(ctx context.Context, pushRoutingID string) error
}
