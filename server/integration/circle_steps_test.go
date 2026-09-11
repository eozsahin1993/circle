package integration_test

import (
	"fmt"
	"net/http"
	"testing"

	"circle-relay/integration/harness"
	"circle-relay/internal/storage/logstore"
)

// No tests here — this is the vocabulary the sync-log sequences in
// log_test.go and authority_test.go are written in: a circle, the two
// capabilities that write to it, and one step per relay operation. Same
// idea as the device helpers at the top of invite_test.go, in a file of
// its own because two test files share it, and named _test.go only
// because that's the one way Go compiles it into the test binary.
//
// Signatures here are real ed25519 over the message logstore itself
// builds. Reproducing the construction by hand would let a test pass by
// making the same mistake the relay makes.

const (
	meta    = string(logstore.NamespaceMeta)
	content = string(logstore.NamespaceContent)
)

// circle is one bootstrapped circle and everything needed to write to it.
type circle struct {
	t      *testing.T
	device *harness.Device
	syncID string
	// token is the *current* write capability. rotate replaces it, which
	// is what makes a copy taken before a rotation a genuinely stale token
	// rather than an invented wrong one.
	token harness.WriteToken
	// admin is the founding authority — the sole member of the circle's
	// authority set until a promotion adds another.
	admin harness.Authority
}

// unknownCircle is a syncId the relay has never heard of, carrying
// well-formed capabilities that can't match anything — for the paths that
// have to refuse a circle rather than a credential. Bootstrapping one is
// what makes it a circle, which is exactly what newCircle does.
func unknownCircle(t *testing.T, r *harness.Relay) *circle {
	t.Helper()
	return &circle{
		t:      t,
		device: r.SignIn(),
		syncID: harness.Suffix(),
		token:  harness.NewWriteToken(),
		admin:  harness.NewAuthority(t),
	}
}

func newCircle(t *testing.T, r *harness.Relay) *circle {
	t.Helper()
	c := unknownCircle(t, r)
	c.device.Post(c.path(), harness.Body{
		"founderAuthorityPublicKey": c.admin.PublicKey(),
		"initialWriteTokenHash":     c.token.Hash,
	}).Expect(http.StatusCreated)
	return c
}

func (c *circle) path() string { return "/v1/circles/" + c.syncID }

// appendBody is one ordinary append, with the fields a sequence usually
// doesn't care about already filled in.
func (c *circle) appendBody(ns, entryID string) harness.Body {
	return harness.Body{
		"namespace":     ns,
		"entryId":       entryID,
		"encryptedMeta": harness.Ciphertext(),
		"keyVersion":    1,
		"writeToken":    c.token.Token,
	}
}

func (c *circle) appendEntry(ns, entryID string) harness.Response {
	return c.device.Post(c.path()+"/entries", c.appendBody(ns, entryID))
}

// appendWith is appendEntry with fields overridden — for the tests about
// one field being wrong rather than about the sequence.
func (c *circle) appendWith(ns, entryID string, overrides harness.Body) harness.Response {
	return c.device.Post(c.path()+"/entries", override(c.appendBody(ns, entryID), overrides))
}

// commit is what every write path hands back: where the entry landed.
type commit struct {
	Epoch      int64
	ReceivedAt int64
}

func (c *circle) mustAppend(ns, entryID string) commit {
	c.t.Helper()
	var result commit
	c.appendEntry(ns, entryID).Expect(http.StatusOK).Decode(&result)
	return result
}

type logEntry struct {
	Epoch         int64
	KeyVersion    int64
	EncryptedMeta string
	ReceivedAt    int64
}

type logPage struct {
	Entries      []logEntry
	CurrentEpoch int64
}

// read is one page of a namespace, everything strictly after since.
func (c *circle) read(ns string, since int64) logPage {
	c.t.Helper()
	var page logPage
	c.device.Get(fmt.Sprintf("%s/entries?namespace=%s&since=%d", c.path(), ns, since)).
		Expect(http.StatusOK).Decode(&page)
	return page
}

// entries is a whole namespace from the beginning — what a device joining
// today replays.
func (c *circle) entries(ns string) []logEntry {
	c.t.Helper()
	return c.read(ns, 0).Entries
}

// epochs asks what a device polling for changes would be told.
func (c *circle) epochs() (metaEpoch, contentEpoch int64) {
	c.t.Helper()
	var peeked struct {
		Circles []struct {
			SyncID       string
			MetaEpoch    int64
			ContentEpoch int64
		}
	}
	c.device.Post("/v1/epochs/peek", harness.Body{"syncIds": []string{c.syncID}}).
		Expect(http.StatusOK).Decode(&peeked)

	if len(peeked.Circles) == 0 {
		return 0, 0
	}
	return peeked.Circles[0].MetaEpoch, peeked.Circles[0].ContentEpoch
}

// rotationBody is one rotation, signed by signer over the message the
// relay will rebuild for itself.
func (c *circle) rotationBody(next harness.WriteToken, signer harness.Authority) harness.Body {
	entryID := harness.Suffix()
	return harness.Body{
		"entryId":       entryID,
		"encryptedMeta": harness.Ciphertext(),
		// The pre-rotation version, always: the key_rotation entry is
		// encrypted under the key being rotated away from.
		"currentKeyVersion":  1,
		"currentWriteToken":  c.token.Token,
		"newWriteTokenHash":  next.Hash,
		"authorityPublicKey": signer.PublicKey(),
		"signature":          signer.Sign(logstore.RotateMessage(c.syncID, entryID, next.Hash)),
	}
}

// rotate must succeed, and adopts the token it minted — every later write
// has to present the new one.
func (c *circle) rotate(signer harness.Authority) commit {
	c.t.Helper()
	next := harness.NewWriteToken()

	var result commit
	c.device.Post(c.path()+"/rotate", c.rotationBody(next, signer)).Expect(http.StatusOK).Decode(&result)

	c.token = next
	return result
}

// attemptRotation sends a rotation that isn't expected to land, so it
// leaves c.token alone — a refused rotation must leave the circle
// writable with the token it already had.
func (c *circle) attemptRotation(body harness.Body) harness.Response {
	return c.device.Post(c.path()+"/rotate", body)
}

func (c *circle) authorityBody(action logstore.AuthorityAction, target string, signer harness.Authority) harness.Body {
	entryID := harness.Suffix()
	change := logstore.AuthorityChange{
		Action:                   action,
		SyncID:                   c.syncID,
		EntryID:                  entryID,
		TargetAuthorityPublicKey: target,
	}
	return harness.Body{
		"entryId":       entryID,
		"encryptedMeta": harness.Ciphertext(),
		"keyVersion":    1,
		"writeToken":    c.token.Token,

		"action":                   string(action),
		"targetAuthorityPublicKey": target,
		"signerAuthorityPublicKey": signer.PublicKey(),
		"signature":                signer.Sign(change.Message()),
	}
}

func (c *circle) promote(target string, signer harness.Authority) harness.Response {
	return c.device.Post(c.path()+"/authority", c.authorityBody(logstore.AuthorityAdd, target, signer))
}

func (c *circle) demote(target string, signer harness.Authority) harness.Response {
	return c.device.Post(c.path()+"/authority", c.authorityBody(logstore.AuthorityRemove, target, signer))
}

// deletionBody is built separately from the call so a test can send the
// same one twice. A second deletion with a *fresh* entry id isn't a retry
// — it's a new deletion of a circle that's already gone, which the relay
// refuses.
func (c *circle) deletionBody(signer harness.Authority) harness.Body {
	entryID := harness.Suffix()
	deletion := logstore.CircleDeletion{SyncID: c.syncID, EntryID: entryID}
	return harness.Body{
		"entryId":                  entryID,
		"encryptedMeta":            harness.Ciphertext(),
		"keyVersion":               1,
		"writeToken":               c.token.Token,
		"signerAuthorityPublicKey": signer.PublicKey(),
		"signature":                signer.Sign(deletion.Message()),
	}
}

func (c *circle) deleteCircle(signer harness.Authority) harness.Response {
	return c.attemptDeletion(c.deletionBody(signer))
}

func (c *circle) attemptDeletion(body harness.Body) harness.Response {
	return c.device.Post(c.path()+"/delete", body)
}

func override(body, overrides harness.Body) harness.Body {
	for field, value := range overrides {
		body[field] = value
	}
	return body
}

// epochSequence renders a page's epochs for the assertions about ordering
// rather than about one entry. A string because Go can't compare slices,
// and "[1 2 3]" against "[1 3]" says more on failure than a length does.
func epochSequence(entries []logEntry) string {
	got := make([]int64, len(entries))
	for i, entry := range entries {
		got[i] = entry.Epoch
	}
	return fmt.Sprint(got)
}
