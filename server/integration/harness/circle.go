package harness

import (
	"fmt"
	"net/http"
	"testing"

	"circle-relay/internal/storage/logstore"
)

// A circle and the steps that drive one: the two capabilities that write
// to it, and one method per relay operation, so a sequence reads as steps
// taken rather than as method-and-path.
//
// Signatures here are real ed25519 over the message logstore itself
// builds. Reproducing the construction by hand would let a test pass by
// making the same mistake the relay makes.

// The two namespaces, as the wire spells them.
const (
	Meta    = string(logstore.NamespaceMeta)
	Content = string(logstore.NamespaceContent)
)

// Circle is one circle on the relay and everything needed to write to it.
type Circle struct {
	t      *testing.T
	Device *Device
	SyncID string
	// Token is the *current* write capability. Rotate replaces it, which
	// is what makes a copy taken before a rotation a genuinely stale token
	// rather than an invented wrong one.
	Token WriteToken
	// Admin is the founding authority — the sole member of the circle's
	// authority set until a promotion adds another.
	Admin Authority
}

// UnknownCircle is a syncId the relay has never heard of, carrying
// well-formed capabilities that can't match anything — for the paths that
// have to refuse a circle rather than a credential. Bootstrapping one is
// what makes it a circle, which is exactly what NewCircle does.
func UnknownCircle(t *testing.T, r *Relay) *Circle {
	t.Helper()
	return &Circle{
		t:      t,
		Device: r.SignIn(),
		SyncID: Suffix(),
		Token:  NewWriteToken(),
		Admin:  NewAuthority(t),
	}
}

func NewCircle(t *testing.T, r *Relay) *Circle {
	t.Helper()
	c := UnknownCircle(t, r)
	c.Device.Post(c.Path(), Body{
		"founderAuthorityPublicKey": c.Admin.PublicKey(),
		"initialWriteTokenHash":     c.Token.Hash,
	}).Expect(http.StatusCreated)
	return c
}

func (c *Circle) Path() string { return "/v1/circles/" + c.SyncID }

// AppendBody is one ordinary append, with the fields a sequence usually
// doesn't care about already filled in.
func (c *Circle) AppendBody(ns, entryID string) Body {
	return Body{
		"namespace":     ns,
		"entryId":       entryID,
		"encryptedMeta": Ciphertext(),
		"keyVersion":    1,
		"writeToken":    c.Token.Raw,
	}
}

func (c *Circle) AppendEntry(ns, entryID string) Response {
	return c.Device.Post(c.Path()+"/entries", c.AppendBody(ns, entryID))
}

// AppendWith is AppendEntry with fields overridden — for the tests about
// one field being wrong rather than about the sequence.
func (c *Circle) AppendWith(ns, entryID string, overrides Body) Response {
	return c.Device.Post(c.Path()+"/entries", override(c.AppendBody(ns, entryID), overrides))
}

// Commit is what every write path hands back: where the entry landed.
type Commit struct {
	Epoch      int64
	ReceivedAt int64
}

func (c *Circle) MustAppend(ns, entryID string) Commit {
	c.t.Helper()
	var result Commit
	c.AppendEntry(ns, entryID).Expect(http.StatusOK).Decode(&result)
	return result
}

type LogEntry struct {
	Epoch         int64
	KeyVersion    int64
	EncryptedMeta string
	ReceivedAt    int64
}

type LogPage struct {
	Entries      []LogEntry
	CurrentEpoch int64
}

// Read is one page of a namespace, everything strictly after since.
func (c *Circle) Read(ns string, since int64) LogPage {
	c.t.Helper()
	var page LogPage
	c.Device.Get(fmt.Sprintf("%s/entries?namespace=%s&since=%d", c.Path(), ns, since)).
		Expect(http.StatusOK).Decode(&page)
	return page
}

// Entries is a whole namespace from the beginning — what a device joining
// today replays.
func (c *Circle) Entries(ns string) []LogEntry {
	c.t.Helper()
	return c.Read(ns, 0).Entries
}

// Epochs asks what a device polling for changes would be told.
func (c *Circle) Epochs() (metaEpoch, contentEpoch int64) {
	c.t.Helper()
	var peeked struct {
		Circles []struct {
			SyncID       string
			MetaEpoch    int64
			ContentEpoch int64
		}
	}
	c.Device.Post("/v1/epochs/peek", Body{"syncIds": []string{c.SyncID}}).
		Expect(http.StatusOK).Decode(&peeked)

	if len(peeked.Circles) == 0 {
		return 0, 0
	}
	return peeked.Circles[0].MetaEpoch, peeked.Circles[0].ContentEpoch
}

// RotationBody is one rotation, signed by signer over the message the
// relay will rebuild for itself.
func (c *Circle) RotationBody(next WriteToken, signer Authority) Body {
	entryID := Suffix()
	return Body{
		"entryId":       entryID,
		"encryptedMeta": Ciphertext(),
		// The pre-rotation version, always: the key_rotation entry is
		// encrypted under the key being rotated away from.
		"currentKeyVersion":  1,
		"currentWriteToken":  c.Token.Raw,
		"newWriteTokenHash":  next.Hash,
		"authorityPublicKey": signer.PublicKey(),
		"signature":          signer.Sign(logstore.RotateMessage(c.SyncID, entryID, next.Hash)),
	}
}

// Rotate must succeed, and adopts the token it minted — every later write
// has to present the new one.
func (c *Circle) Rotate(signer Authority) Commit {
	c.t.Helper()
	next := NewWriteToken()

	var result Commit
	c.Device.Post(c.Path()+"/rotate", c.RotationBody(next, signer)).Expect(http.StatusOK).Decode(&result)

	c.Token = next
	return result
}

// AttemptRotation sends a rotation that isn't expected to land, so it
// leaves c.Token alone — a refused rotation must leave the circle
// writable with the token it already had.
func (c *Circle) AttemptRotation(body Body) Response {
	return c.Device.Post(c.Path()+"/rotate", body)
}

func (c *Circle) authorityBody(action logstore.AuthorityAction, target string, signer Authority) Body {
	entryID := Suffix()
	change := logstore.AuthorityChange{
		Action:                   action,
		SyncID:                   c.SyncID,
		EntryID:                  entryID,
		TargetAuthorityPublicKey: target,
	}
	return Body{
		"entryId":       entryID,
		"encryptedMeta": Ciphertext(),
		"keyVersion":    1,
		"writeToken":    c.Token.Raw,

		"action":                   string(action),
		"targetAuthorityPublicKey": target,
		"signerAuthorityPublicKey": signer.PublicKey(),
		"signature":                signer.Sign(change.Message()),
	}
}

func (c *Circle) Promote(target string, signer Authority) Response {
	return c.Device.Post(c.Path()+"/authority", c.authorityBody(logstore.AuthorityAdd, target, signer))
}

func (c *Circle) Demote(target string, signer Authority) Response {
	return c.Device.Post(c.Path()+"/authority", c.authorityBody(logstore.AuthorityRemove, target, signer))
}

// DeletionBody is built separately from the call so a test can send the
// same one twice. A second deletion with a *fresh* entry id isn't a retry
// — it's a new deletion of a circle that's already gone, which the relay
// refuses.
func (c *Circle) DeletionBody(signer Authority) Body {
	entryID := Suffix()
	deletion := logstore.CircleDeletion{SyncID: c.SyncID, EntryID: entryID}
	return Body{
		"entryId":                  entryID,
		"encryptedMeta":            Ciphertext(),
		"keyVersion":               1,
		"writeToken":               c.Token.Raw,
		"signerAuthorityPublicKey": signer.PublicKey(),
		"signature":                signer.Sign(deletion.Message()),
	}
}

func (c *Circle) DeleteCircle(signer Authority) Response {
	return c.AttemptDeletion(c.DeletionBody(signer))
}

func (c *Circle) AttemptDeletion(body Body) Response {
	return c.Device.Post(c.Path()+"/delete", body)
}

func override(body, overrides Body) Body {
	for field, value := range overrides {
		body[field] = value
	}
	return body
}

// EpochSequence renders a page's epochs for the assertions about ordering
// rather than about one entry. A string because Go can't compare slices,
// and "[1 2 3]" against "[1 3]" says more on failure than a length does.
func EpochSequence(entries []LogEntry) string {
	got := make([]int64, len(entries))
	for i, entry := range entries {
		got[i] = entry.Epoch
	}
	return fmt.Sprint(got)
}
