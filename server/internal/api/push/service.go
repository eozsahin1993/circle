// Package push is the vertical slice for /push/ — see
// server/PUSH_DESIGN.md. Addressed by routing id, not account: the relay
// holds no link between the two, so there is nothing to nest under.
//
// Payloads arrive as ciphertext and are forwarded untouched.
package push

import (
	"context"
	"crypto/hmac"
	"errors"

	"circle-relay/internal/storage/pushstore"
	"circle-relay/internal/storage/ratelimitstore"
)

// MaxFanoutTargets caps one send. A circle's membership is bounded, so a
// larger request isn't a real one, and rejecting costs no storage reads.
const MaxFanoutTargets = 256

type Service struct {
	PushStore pushstore.Store
	// Keyed on the routing id. The only limit here protecting a person
	// rather than the relay: verification stops an outsider, but a real
	// member passes it every time and nothing else bounds them.
	RecipientLimit ratelimitstore.Store
}

// ErrTooManyTargets is returned when a send exceeds MaxFanoutTargets.
var ErrTooManyTargets = errors.New("push: too many fanout targets")

func (s *Service) PutPrefs(ctx context.Context, pushRoutingID string, prefs pushstore.Prefs) error {
	return s.PushStore.PutPrefs(ctx, pushRoutingID, prefs)
}

func (s *Service) PutDevice(ctx context.Context, pushRoutingID string, device pushstore.Device) error {
	return s.PushStore.PutDevice(ctx, pushRoutingID, device)
}

func (s *Service) DeleteDevice(ctx context.Context, pushRoutingID, deviceID string) error {
	return s.PushStore.DeleteDevice(ctx, pushRoutingID, deviceID)
}

func (s *Service) DeleteRouting(ctx context.Context, pushRoutingID string) error {
	return s.PushStore.DeleteRouting(ctx, pushRoutingID)
}

// Delivery is one resolved target.
type Delivery struct {
	PushToken []byte
	Platform  string
}

// FanoutResult is counts, not per-target detail: saying *which* ids failed
// would make this an oracle for probing which ones exist.
type FanoutResult struct {
	Deliveries []Delivery
	Skipped    int
}

// Fanout resolves a send into the deliveries it should produce.
//
// Order is load-bearing: cap, then verify, then charge budget. Budgeting
// first would let an attacker cycling random ids make the relay *write* a
// row per nonexistent target — the limiter becomes the amplification.
//
// A failed target is skipped, never fatal: one recipient over budget must
// not silence the rest of the circle.
func (s *Service) Fanout(ctx context.Context, pushRoutingIDs []string, pushFanoutToken []byte, category int64) (FanoutResult, error) {
	if len(pushRoutingIDs) > MaxFanoutTargets {
		return FanoutResult{}, ErrTooManyTargets
	}

	var result FanoutResult
	for _, pushRoutingID := range pushRoutingIDs {
		deliveries, err := s.resolve(ctx, pushRoutingID, pushFanoutToken, category)
		if err != nil {
			return FanoutResult{}, err
		}
		if len(deliveries) == 0 {
			result.Skipped++
			continue
		}
		result.Deliveries = append(result.Deliveries, deliveries...)
	}
	return result, nil
}

// resolve returns one routing id's deliveries, or nil to skip. Only a
// storage failure is an error — the caller must not learn which targets
// were rejected, or why.
func (s *Service) resolve(ctx context.Context, pushRoutingID string, pushFanoutToken []byte, category int64) ([]Delivery, error) {
	prefs, err := s.PushStore.GetPrefs(ctx, pushRoutingID)
	if errors.Is(err, pushstore.ErrPushRoutingNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	// Constant time, or a caller could test tokens a byte at a time.
	if !hmac.Equal(prefs.PushFanoutHash, PushFanoutHash(pushFanoutToken, pushRoutingID)) {
		return nil, nil
	}
	if category < 0 || category > MaxCategory || prefs.CategoryMask&(1<<uint(category)) == 0 {
		return nil, nil
	}

	allowed, err := s.RecipientLimit.Allow(ctx, pushRoutingID)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, nil
	}

	devices, err := s.PushStore.ListDevices(ctx, pushRoutingID)
	if err != nil {
		return nil, err
	}

	deliveries := make([]Delivery, 0, len(devices))
	for _, device := range devices {
		if !device.Enabled {
			continue
		}
		deliveries = append(deliveries, Delivery{PushToken: device.PushToken, Platform: device.Platform})
	}
	return deliveries, nil
}
