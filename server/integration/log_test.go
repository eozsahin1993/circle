package integration_test

import (
	"fmt"
	"net/http"
	"testing"

	"circle-relay/integration/harness"
)

// createlog, appendlog and getlog, end to end — see server/SYNC_DESIGN.md.
// Each test is a sequence, because that's where this half of the relay's
// behaviour lives: what a device gets back when it replays from zero, what
// a second call with an advanced cursor returns, and what a retry does to
// a log that is never allowed to hold the same entry twice.
//
// The endpoints are harness.Circle's methods — see harness/circle.go.

func TestAnEntryComesBackTheWayItWentIn(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	entry := c.NewAppend(harness.Meta)
	entry.KeyVersion = 7
	c.AppendLog(entry).Expect(http.StatusOK)

	page := c.GetLog(harness.Meta, 0)
	harness.AssertEqual(t, len(page.Entries), 1, "entries after one append")
	harness.AssertEqual(t, page.Entries[0].EncryptedMeta, entry.EncryptedMeta, "the entry's payload")
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

	c.MustAppend(harness.Meta)
	c.MustAppend(harness.Meta)
	first := c.MustAppend(harness.Content)

	// Content starts at 1 despite two meta entries already being down.
	// They're permanently independent sequences, not one log with a label
	// — a device syncs each against its own cursor.
	harness.AssertEqual(t, first.Epoch, int64(1), "the first content epoch")
	harness.AssertEqual(t, harness.EpochSequence(c.Entries(harness.Meta)), "[1 2]", "the meta namespace")
	harness.AssertEqual(t, harness.EpochSequence(c.Entries(harness.Content)), "[1]", "the content namespace")

	metaEpoch, contentEpoch := c.PeekEpochs()
	harness.AssertEqual(t, metaEpoch, int64(2), "the peeked meta epoch")
	harness.AssertEqual(t, contentEpoch, int64(1), "the peeked content epoch")
}

func TestReadingFromACursorReturnsOnlyWhatFollowedIt(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	for range 3 {
		c.MustAppend(harness.Content)
	}

	harness.AssertEqual(t, harness.EpochSequence(c.GetLog(harness.Content, 0).Entries), "[1 2 3]", "a replay from zero")
	harness.AssertEqual(t, harness.EpochSequence(c.GetLog(harness.Content, 2).Entries), "[3]", "a read from epoch 2")

	// Caught up: nothing new, but still told where the namespace is, which
	// is how a client knows its cursor is current rather than merely
	// unlucky in a short page.
	caughtUp := c.GetLog(harness.Content, 3)
	harness.AssertEqual(t, len(caughtUp.Entries), 0, "entries past the last one")
	harness.AssertEqual(t, caughtUp.CurrentEpoch, int64(3), "the current epoch when caught up")
}

func TestAppendingTheSameEntryTwiceLandsItOnce(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	first := c.NewAppend(harness.Content)
	var firstCommit harness.Commit
	c.AppendLog(first).Expect(http.StatusOK).Decode(&firstCommit)

	// A client that didn't hear back retries under the same entryId, with
	// a freshly-sealed payload. The entry already down must win: the log
	// is never rewritten, and a second epoch for the same entry would show
	// up on every other device as a duplicate post.
	retry := first
	retry.EncryptedMeta = harness.Ciphertext()
	var retryCommit harness.Commit
	c.AppendLog(retry).Expect(http.StatusOK).Decode(&retryCommit)

	harness.AssertEqual(t, retryCommit.Epoch, firstCommit.Epoch, "the epoch a retry reported")
	harness.AssertEqual(t, retryCommit.ReceivedAt, firstCommit.ReceivedAt, "the receivedAt a retry reported")

	entries := c.Entries(harness.Content)
	harness.AssertEqual(t, len(entries), 1, "entries after a retry")
	harness.AssertEqual(t, entries[0].EncryptedMeta, first.EncryptedMeta, "the surviving payload")
}

func TestAnEntryIDOnlyCollidesWithinItsOwnNamespace(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	// Idempotency is per (circle, namespace, entryId). Were it per circle,
	// a client reusing an id across the two sequences would silently lose
	// the second entry rather than store both.
	inMeta := c.NewAppend(harness.Meta)
	inContent := c.NewAppend(harness.Content)
	inContent.EntryID = inMeta.EntryID

	c.AppendLog(inMeta).Expect(http.StatusOK)
	c.AppendLog(inContent).Expect(http.StatusOK)

	harness.AssertEqual(t, len(c.Entries(harness.Meta)), 1, "meta entries")
	harness.AssertEqual(t, len(c.Entries(harness.Content)), 1, "content entries")
}

func TestEntriesDontLeakBetweenCircles(t *testing.T) {
	r := harness.Start(t)
	mine, theirs := harness.NewCircle(t, r), harness.NewCircle(t, r)

	mine.MustAppend(harness.Content)

	harness.AssertEqual(t, len(theirs.Entries(harness.Content)), 0, "entries under the other circle")
	harness.AssertEqual(t, theirs.GetLog(harness.Content, 0).CurrentEpoch, int64(0), "the other circle's current epoch")
}

func TestReadingACircleThatWasNeverCreatedIsEmptyNotMissing(t *testing.T) {
	r := harness.Start(t)

	// Documents what happens today rather than asserting a rule: a read of
	// an unknown syncId is an empty log, not a 404, while a write to one
	// is a 404 (below). The asymmetry is deliberate on the write side —
	// there's nothing to append to — and worth pinning here so a change to
	// either half is a visible decision.
	page := harness.UnknownCircle(t, r).GetLog(harness.Content, 0)

	harness.AssertEqual(t, len(page.Entries), 0, "entries in a circle that doesn't exist")
	harness.AssertEqual(t, page.CurrentEpoch, int64(0), "the current epoch of a circle that doesn't exist")
}

func TestAppendingToACircleThatWasNeverCreatedIsNotFound(t *testing.T) {
	r := harness.Start(t)
	c := harness.UnknownCircle(t, r)

	c.AppendLog(c.NewAppend(harness.Content)).Expect(http.StatusNotFound)
}

func TestPeekSkipsACircleItDoesntHave(t *testing.T) {
	r := harness.Start(t)

	// Omitted rather than an error: peek names a device's whole circle set
	// in one call, and one stale id in it mustn't cost the device its
	// epochs for every other circle.
	metaEpoch, contentEpoch := harness.UnknownCircle(t, r).PeekEpochs()
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
	second := c.NewCreate()
	second.FounderAuthorityPublicKey = harness.NewAuthority(t).PublicKey()
	second.InitialWriteTokenHash = harness.NewWriteToken().Hash
	c.CreateLog(second).Expect(http.StatusConflict)
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
			req := c.NewAppend(harness.Content)
			req.WriteToken = token
			c.AppendLog(req).Expect(http.StatusForbidden)
		})
	}

	harness.AssertEqual(t, len(c.Entries(harness.Content)), 0, "entries a refused append left behind")
}

func TestReadingTakesASessionAndNothingElse(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	c.MustAppend(harness.Content)

	entriesPath := fmt.Sprintf("%s/entries?namespace=%s&since=0", c.Path(), harness.Content)

	// A different account, holding no write token, reads the ciphertext.
	// That's the design, not a hole: the log's confidentiality is the
	// encryption, and the relay is blind to what it's storing (invariant
	// 3). Gating reads would buy nothing and would mean the relay knowing
	// who belongs to which circle.
	var page harness.LogPage
	r.SignIn().Get(entriesPath).Expect(http.StatusOK).Decode(&page)
	harness.AssertEqual(t, len(page.Entries), 1, "entries a stranger could read")

	// A session is still required, so a syncId alone isn't a credential.
	r.Anon().Get(entriesPath).Expect(http.StatusUnauthorized)
	r.Anon().PostRequest(c.Path()+"/entries", c.NewAppend(harness.Content)).Expect(http.StatusUnauthorized)
}

func TestAnAppendWithAFieldWrongIsRejected(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	// 400 rather than 403: a request the relay can't even read is a client
	// bug, and answering it with the same "wrong token" it gives a real
	// rejection would send the client rotating keys to fix a typo.
	bend := map[string]func(*harness.AppendRequest){
		"a namespace that isn't one":  func(a *harness.AppendRequest) { a.Namespace = "posts" },
		"no namespace at all":         func(a *harness.AppendRequest) { a.Namespace = "" },
		"no entry id":                 func(a *harness.AppendRequest) { a.EntryID = "" },
		"a zero key version":          func(a *harness.AppendRequest) { a.KeyVersion = 0 },
		"a negative key version":      func(a *harness.AppendRequest) { a.KeyVersion = -1 },
		"no write token":              func(a *harness.AppendRequest) { a.WriteToken = "" },
		"a payload that isn't base64": func(a *harness.AppendRequest) { a.EncryptedMeta = "not base64!" },
	}

	for what, bendIt := range bend {
		t.Run(what, func(t *testing.T) {
			req := c.NewAppend(harness.Content)
			bendIt(&req)
			c.AppendLog(req).Expect(http.StatusBadRequest)
		})
	}
}
