package integration_test

import (
	"fmt"
	"net/http"
	"testing"

	"circle-relay/integration/harness"
)

// The append-only log, end to end — see server/SYNC_DESIGN.md. Each test
// is a sequence, because that's where this half of the relay's behaviour
// lives: what a device gets back when it replays from zero, what a second
// call with an advanced cursor returns, and what a retry does to a log
// that is never allowed to hold the same entry twice.
//
// The steps are harness.Circle — see integration/harness/circle.go.

func TestAnEntryComesBackTheWayItWentIn(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	payload := harness.Ciphertext()
	c.AppendWith(harness.Meta, harness.Suffix(), harness.Body{"encryptedMeta": payload, "keyVersion": 7}).
		Expect(http.StatusOK)

	page := c.Read(harness.Meta, 0)
	harness.AssertEqual(t, len(page.Entries), 1, "entries after one append")
	harness.AssertEqual(t, page.Entries[0].EncryptedMeta, payload, "the entry's payload")
	harness.AssertEqual(t, page.Entries[0].Epoch, int64(1), "the first entry's epoch")
	harness.AssertEqual(t, page.CurrentEpoch, int64(1), "the namespace's current epoch")
	// keyVersion is the one part of an entry the relay stores in the
	// clear, so a reader can pick the right content key by lookup instead
	// of trial-decrypting with every version it holds.
	harness.AssertEqual(t, page.Entries[0].KeyVersion, int64(7), "the entry's key version")
	harness.AssertTrue(t, page.Entries[0].ReceivedAt > 0, "the relay stamped no receivedAt")
}

func TestTheTwoNamespacesAreSeparateSequences(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	c.MustAppend(harness.Meta, harness.Suffix())
	c.MustAppend(harness.Meta, harness.Suffix())
	first := c.MustAppend(harness.Content, harness.Suffix())

	// Content starts at 1 despite two meta entries already being down.
	// They're permanently independent sequences, not one log with a label
	// — a device syncs each against its own cursor.
	harness.AssertEqual(t, first.Epoch, int64(1), "the first content epoch")
	harness.AssertEqual(t, harness.EpochSequence(c.Entries(harness.Meta)), "[1 2]", "the meta namespace")
	harness.AssertEqual(t, harness.EpochSequence(c.Entries(harness.Content)), "[1]", "the content namespace")

	metaEpoch, contentEpoch := c.Epochs()
	harness.AssertEqual(t, metaEpoch, int64(2), "the peeked meta epoch")
	harness.AssertEqual(t, contentEpoch, int64(1), "the peeked content epoch")
}

func TestReadingFromACursorReturnsOnlyWhatFollowedIt(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	for range 3 {
		c.MustAppend(harness.Content, harness.Suffix())
	}

	harness.AssertEqual(t, harness.EpochSequence(c.Read(harness.Content, 0).Entries), "[1 2 3]", "a replay from zero")
	harness.AssertEqual(t, harness.EpochSequence(c.Read(harness.Content, 2).Entries), "[3]", "a read from epoch 2")

	// Caught up: nothing new, but still told where the namespace is, which
	// is how a client knows its cursor is current rather than merely
	// unlucky in a short page.
	caughtUp := c.Read(harness.Content, 3)
	harness.AssertEqual(t, len(caughtUp.Entries), 0, "entries past the last one")
	harness.AssertEqual(t, caughtUp.CurrentEpoch, int64(3), "the current epoch when caught up")
}

func TestAppendingTheSameEntryTwiceLandsItOnce(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	entryID := harness.Suffix()
	payload := harness.Ciphertext()
	var first harness.Commit
	c.AppendWith(harness.Content, entryID, harness.Body{"encryptedMeta": payload}).
		Expect(http.StatusOK).Decode(&first)

	// A client that didn't hear back retries with the same entryId and a
	// freshly-sealed payload. The entry it already has must win: the log
	// is never rewritten, and a second epoch for the same entry would show
	// up on every other device as a duplicate post.
	var second harness.Commit
	c.AppendWith(harness.Content, entryID, harness.Body{"encryptedMeta": harness.Ciphertext()}).
		Expect(http.StatusOK).Decode(&second)

	harness.AssertEqual(t, second.Epoch, first.Epoch, "the epoch a retry reported")
	harness.AssertEqual(t, second.ReceivedAt, first.ReceivedAt, "the receivedAt a retry reported")

	entries := c.Entries(harness.Content)
	harness.AssertEqual(t, len(entries), 1, "entries after a retry")
	harness.AssertEqual(t, entries[0].EncryptedMeta, payload, "the surviving payload")
}

func TestAnEntryIDOnlyCollidesWithinItsOwnNamespace(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	// Idempotency is per (circle, namespace, entryId). Were it per circle,
	// a client reusing an id across the two sequences would silently lose
	// the second entry rather than store both.
	entryID := harness.Suffix()
	c.MustAppend(harness.Meta, entryID)
	c.MustAppend(harness.Content, entryID)

	harness.AssertEqual(t, len(c.Entries(harness.Meta)), 1, "meta entries")
	harness.AssertEqual(t, len(c.Entries(harness.Content)), 1, "content entries")
}

func TestEntriesDontLeakBetweenCircles(t *testing.T) {
	r := harness.Start(t)
	mine, theirs := harness.NewCircle(t, r), harness.NewCircle(t, r)

	mine.MustAppend(harness.Content, harness.Suffix())

	harness.AssertEqual(t, len(theirs.Entries(harness.Content)), 0, "entries under the other circle")
	harness.AssertEqual(t, theirs.Read(harness.Content, 0).CurrentEpoch, int64(0), "the other circle's current epoch")
}

func TestReadingACircleThatWasNeverCreatedIsEmptyNotMissing(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	// Documents what happens today rather than asserting a rule: a read of
	// an unknown syncId is an empty log, not a 404, while a write to one
	// is a 404 (below). The asymmetry is deliberate on the write side —
	// there's nothing to append to — and worth pinning here so a change to
	// either half is a visible decision.
	var page harness.LogPage
	c.Device.Get(fmt.Sprintf("/v1/circles/%s/entries?namespace=%s&since=0", harness.Suffix(), harness.Content)).
		Expect(http.StatusOK).Decode(&page)

	harness.AssertEqual(t, len(page.Entries), 0, "entries in a circle that doesn't exist")
	harness.AssertEqual(t, page.CurrentEpoch, int64(0), "the current epoch of a circle that doesn't exist")
}

func TestAppendingToACircleThatWasNeverCreatedIsNotFound(t *testing.T) {
	r := harness.Start(t)
	harness.UnknownCircle(t, r).AppendEntry(harness.Content, harness.Suffix()).Expect(http.StatusNotFound)
}

func TestPeekSkipsACircleItDoesntHave(t *testing.T) {
	r := harness.Start(t)
	// Omitted rather than an error: peek names a device's whole circle set
	// in one call, and one stale id in it mustn't cost the device its
	// epochs for every other circle.
	metaEpoch, contentEpoch := harness.UnknownCircle(t, r).Epochs()
	harness.AssertEqual(t, metaEpoch, int64(0), "the meta epoch reported for an unknown circle")
	harness.AssertEqual(t, contentEpoch, int64(0), "the content epoch reported for an unknown circle")
}

func TestCreatingACircleTwiceIsAConflict(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	// Not merely untidy: a second Bootstrap would install a new authority
	// set and a new write token over a live circle, locking out everyone
	// already in it. The syncId is client-chosen, so this is what stops a
	// guessed one being claimed.
	c.Device.Post(c.Path(), harness.Body{
		"founderAuthorityPublicKey": harness.NewAuthority(t).PublicKey(),
		"initialWriteTokenHash":     harness.NewWriteToken().Hash,
	}).Expect(http.StatusConflict)
}

func TestAWriteTokenThatIsntTheCurrentOneIsRefused(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	other := harness.NewCircle(t, r)

	// Every one of these is the same 403, deliberately — see
	// server/SYNC_DESIGN.md's "possession, not identity". The relay can't
	// tell a non-member from a member who hasn't synced past a rotation,
	// and a malformed token can never be correct either, so all three are
	// one outcome rather than three.
	for what, token := range map[string]string{
		"another circle's": other.Token.Raw,
		"a made-up one":    harness.NewWriteToken().Raw,
		"not even hex":     "not-hex",
	} {
		t.Run(what, func(t *testing.T) {
			c.AppendWith(harness.Content, harness.Suffix(), harness.Body{"writeToken": token}).
				Expect(http.StatusForbidden)
		})
	}

	harness.AssertEqual(t, len(c.Entries(harness.Content)), 0, "entries a refused append left behind")
}

func TestReadingTakesASessionAndNothingElse(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	c.MustAppend(harness.Content, harness.Suffix())

	// A different account, holding no write token, reads the ciphertext.
	// That's the design, not a hole: the log's confidentiality is the
	// encryption, and the relay is blind to what it's storing (invariant
	// 3). Gating reads would buy nothing and would mean the relay knowing
	// who belongs to which circle.
	var page harness.LogPage
	r.SignIn().Get(fmt.Sprintf("%s/entries?namespace=%s&since=0", c.Path(), harness.Content)).
		Expect(http.StatusOK).Decode(&page)
	harness.AssertEqual(t, len(page.Entries), 1, "entries a stranger could read")

	// A session is still required, so a syncId alone isn't a credential.
	r.Anon().Get(fmt.Sprintf("%s/entries?namespace=%s&since=0", c.Path(), harness.Content)).
		Expect(http.StatusUnauthorized)
	r.Anon().Post(c.Path()+"/entries", c.AppendBody(harness.Content, harness.Suffix())).
		Expect(http.StatusUnauthorized)
}

func TestAnAppendWithAFieldWrongIsRejected(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	// 400 rather than 403: a request the relay can't even read is a client
	// bug, and answering it with the same "wrong token" it gives a real
	// rejection would send the client rotating keys to fix a typo.
	for what, override := range map[string]harness.Body{
		"a namespace that isn't one":  {"namespace": "posts"},
		"no namespace at all":         {"namespace": ""},
		"no entry id":                 {"entryId": ""},
		"a zero key version":          {"keyVersion": 0},
		"a negative key version":      {"keyVersion": -1},
		"no write token":              {"writeToken": ""},
		"a payload that isn't base64": {"encryptedMeta": "not base64!"},
	} {
		t.Run(what, func(t *testing.T) {
			c.AppendWith(harness.Content, harness.Suffix(), override).Expect(http.StatusBadRequest)
		})
	}
}
