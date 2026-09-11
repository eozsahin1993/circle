package integration_test

import (
	"net/http"
	"testing"

	"circle-relay/integration/harness"
	"circle-relay/internal/storage/logstore"
)

// rotatelog, changeauthority and deletecircle, end to end — the three
// operations an ordinary member can't perform, and the sequences that
// decide who can. See server/SYNC_DESIGN.md's "Authorization": possession
// of the write token proves "a current member", an authority signature on
// top of it proves "an admin", and these paths need both.
//
// The endpoints are harness.Circle's methods — see harness/circle.go.

func TestRotatingReplacesTheWriteToken(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	stale := c.Token

	c.MustRotate(c.Admin)

	// This is what a rotation is *for*: a member removed before it can no
	// longer write, however current their token was a moment ago.
	staleWrite := c.NewAppend(harness.Content)
	staleWrite.WriteToken = stale.Raw
	c.AppendLog(staleWrite).Expect(http.StatusForbidden)

	c.AppendLog(c.NewAppend(harness.Content)).Expect(http.StatusOK)
}

func TestTheRotationItselfLandsInMeta(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	c.MustAppend(harness.Content)

	rotation := c.MustRotate(c.Admin)

	// The rotation is an entry like any other — a device replaying meta
	// has to see it to learn there's a new key at all. Always meta, never
	// content, whatever namespace the traffic around it was in.
	entries := c.Entries(harness.Meta)
	harness.AssertEqual(t, harness.EpochSequence(entries), "[1]", "the meta namespace after a rotation")
	harness.AssertEqual(t, entries[0].Epoch, rotation.Epoch, "the epoch the rotation reported")
	// The *pre*-rotation version: the entry announcing the new key is
	// itself sealed under the old one, or nobody could read it.
	harness.AssertEqual(t, entries[0].KeyVersion, int64(1), "the rotation entry's key version")
	harness.AssertEqual(t, harness.EpochSequence(c.Entries(harness.Content)), "[1]", "the content namespace after a rotation")
}

func TestOnlyAnAdminCanRotate(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	// A real member — NewRotate signs with this key and presents the
	// circle's current write token, so both the signature and the
	// membership check pass. What it doesn't have is a key in the
	// authority set, and rotating is the one thing membership alone
	// doesn't buy.
	member := harness.NewAuthority(t)
	c.RotateLog(c.NewRotate(harness.NewWriteToken(), member)).Expect(http.StatusForbidden)

	// The refused rotation left the circle alone: the token it already had
	// still writes, and no entry recorded the attempt.
	c.AppendLog(c.NewAppend(harness.Content)).Expect(http.StatusOK)
	harness.AssertEqual(t, len(c.Entries(harness.Meta)), 0, "meta entries a refused rotation left behind")
}

func TestRotatingStillNeedsTheCurrentWriteToken(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	// An admin's signature doesn't stand in for membership. An admin whose
	// own token is stale — one who missed somebody else's rotation — is
	// told to catch up rather than allowed to overwrite it.
	req := c.NewRotate(harness.NewWriteToken(), c.Admin)
	req.CurrentWriteToken = harness.NewWriteToken().Raw
	c.RotateLog(req).Expect(http.StatusForbidden)

	c.AppendLog(c.NewAppend(harness.Content)).Expect(http.StatusOK)
}

func TestARotationSignatureOnlyAuthorizesThatRotation(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	// The signature covers the circle, the entry and the new token hash
	// together (logstore.RotateMessage). Move any one of them after
	// NewRotate has signed and what's left is an admin's real signature
	// over a *different* rotation — which must be worth nothing here, or
	// one captured rotation could be replayed to install a token of the
	// attacker's choosing.
	bend := map[string]func(*harness.RotateRequest){
		"a different new token": func(req *harness.RotateRequest) {
			req.NewWriteTokenHash = harness.NewWriteToken().Hash
		},
		"a different entry": func(req *harness.RotateRequest) {
			req.EntryID = harness.Suffix()
		},
		"another circle": func(req *harness.RotateRequest) {
			req.Signature = c.Admin.Sign(logstore.RotateMessage(harness.Suffix(), req.EntryID, req.NewWriteTokenHash))
		},
	}

	for what, bendIt := range bend {
		t.Run(what, func(t *testing.T) {
			req := c.NewRotate(harness.NewWriteToken(), c.Admin)
			bendIt(&req)
			c.RotateLog(req).Expect(http.StatusBadRequest)
		})
	}

	harness.AssertEqual(t, len(c.Entries(harness.Meta)), 0, "meta entries a forged rotation left behind")
}

func TestARetriedRotationIsNotASecondRotation(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	req := c.NewRotate(harness.NewWriteToken(), c.Admin)
	var first harness.Commit
	c.RotateLog(req).Expect(http.StatusOK).Decode(&first)

	// The same request again, byte for byte — an admin who never heard
	// back. It carries the pre-rotation token, which the first call has
	// already retired, so without the entry being recognised as one
	// already committed this would come back 403 and strand a client that
	// rotated successfully into thinking it hadn't.
	var second harness.Commit
	c.RotateLog(req).Expect(http.StatusOK).Decode(&second)

	harness.AssertEqual(t, second.Epoch, first.Epoch, "the epoch a retried rotation reported")
	harness.AssertEqual(t, harness.EpochSequence(c.Entries(harness.Meta)), "[1]", "meta after a retried rotation")
}

func TestAPromotedKeyCanRotate(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	second := harness.NewAuthority(t)

	c.Promote(second.PublicKey(), c.Admin).Expect(http.StatusOK)

	// Authority only ever comes from authority: this key could do nothing
	// a moment ago, and can now because one already in the set said so.
	c.MustRotate(second)
	c.AppendLog(c.NewAppend(harness.Content)).Expect(http.StatusOK)
}

func TestOnlyAnAdminCanPromote(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	outsider := harness.NewAuthority(t)

	// Signed by the key it's trying to add. Nothing seeds the authority
	// set but a key already in it — otherwise any member could hand
	// themselves the one capability membership doesn't include.
	c.Promote(outsider.PublicKey(), outsider).Expect(http.StatusForbidden)

	c.RotateLog(c.NewRotate(harness.NewWriteToken(), outsider)).Expect(http.StatusForbidden)
}

func TestADemotedKeyCannotRotate(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	demoted := harness.NewAuthority(t)

	c.Promote(demoted.PublicKey(), c.Admin).Expect(http.StatusOK)
	c.Demote(demoted.PublicKey(), c.Admin).Expect(http.StatusOK)

	c.RotateLog(c.NewRotate(harness.NewWriteToken(), demoted)).Expect(http.StatusForbidden)
	c.MustRotate(c.Admin)
}

func TestAnAdminCanStepDownWhileAnotherRemains(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	successor := harness.NewAuthority(t)

	c.Promote(successor.PublicKey(), c.Admin).Expect(http.StatusOK)

	// Removing your own key is how leaving hands authority back, so it's
	// allowed — the check is on what the set is left holding, not on who
	// is named.
	c.Demote(c.Admin.PublicKey(), c.Admin).Expect(http.StatusOK)

	c.RotateLog(c.NewRotate(harness.NewWriteToken(), c.Admin)).Expect(http.StatusForbidden)
	c.MustRotate(successor)
}

func TestTheLastAdminCannotStepDown(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	// An empty authority set is unrecoverable: nobody left could rotate,
	// promote or demote, and nothing but authority puts a key back. The
	// circle would be permanently ungovernable, so the relay refuses the
	// step that gets there.
	c.Demote(c.Admin.PublicKey(), c.Admin).Expect(http.StatusConflict)

	c.MustRotate(c.Admin)
}

func TestAnAuthorityKeyHasToBeOne(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	// Checked before it goes in, because a key nothing can sign as could
	// only ever be removed by somebody else — and on a circle with one
	// admin, that's nobody.
	for what, target := range map[string]string{
		"not hex":                 "plainly-not-a-key",
		"hex of the wrong length": "abcdef",
		"empty":                   "",
	} {
		t.Run(what, func(t *testing.T) {
			c.Promote(target, c.Admin).Expect(http.StatusBadRequest)
		})
	}
}

func TestDeletingACircleEndsItsWrites(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	c.MustAppend(harness.Content)

	c.DeleteCircle(c.NewDelete(c.Admin)).Expect(http.StatusOK)

	// Gone rather than forbidden: the token is still the circle's current
	// one, and telling a client its capability is stale would send it
	// looking for a rotation that never happened.
	c.AppendLog(c.NewAppend(harness.Content)).Expect(http.StatusGone)
	c.RotateLog(c.NewRotate(harness.NewWriteToken(), c.Admin)).Expect(http.StatusGone)

	// A *second* deletion — a new entry, not a resend — is refused like
	// any other write. See TestARetriedDeletionPicksTheSweepBackUp for the
	// one that isn't.
	c.DeleteCircle(c.NewDelete(c.Admin)).Expect(http.StatusGone)
}

func TestOnlyAnAdminCanDeleteACircle(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)

	c.DeleteCircle(c.NewDelete(harness.NewAuthority(t))).Expect(http.StatusForbidden)

	c.AppendLog(c.NewAppend(harness.Content)).Expect(http.StatusOK)
}

func TestARetriedDeletionPicksTheSweepBackUp(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	c.MustAppend(harness.Content)

	// Byte for byte, the way a client that never heard back would resend
	// it. Deletion is two steps — tombstone, then sweep — and only the
	// first is atomic, so the sweep behind a tombstone already down may
	// have died partway. The retry has to run it again rather than report
	// the circle already gone and leave whatever the first pass missed.
	req := c.NewDelete(c.Admin)
	var first harness.Commit
	c.DeleteCircle(req).Expect(http.StatusOK).Decode(&first)

	var second harness.Commit
	c.DeleteCircle(req).Expect(http.StatusOK).Decode(&second)

	harness.AssertEqual(t, second.Epoch, first.Epoch, "the epoch a retried deletion reported")
	harness.AssertEqual(t, harness.EpochSequence(c.Entries(harness.Meta)), "[1]", "meta after a retried deletion")
	harness.AssertEqual(t, len(c.Entries(harness.Content)), 0, "content after a retried deletion")
}

func TestTheTombstoneOutlivesWhatItEnded(t *testing.T) {
	r := harness.Start(t)
	c := harness.NewCircle(t, r)
	c.MustAppend(harness.Content)
	c.MustAppend(harness.Content)

	c.DeleteCircle(c.NewDelete(c.Admin)).Expect(http.StatusOK)

	// Meta survives the sweep, tombstone included. A device that hasn't
	// synced since builds its roster from meta and verifies the tombstone
	// against it; sweep meta too and that device skips the tombstone and
	// keeps a circle that no longer exists.
	harness.AssertEqual(t, harness.EpochSequence(c.Entries(harness.Meta)), "[1]", "meta after a deletion")

	// Content is the part that actually goes. The namespace's epoch stays
	// where it was — the counter isn't rewound — so a device still on an
	// old cursor is told there's nothing left to fetch rather than being
	// sent back to replay a log that's gone.
	swept := c.GetLog(harness.Content, 0)
	harness.AssertEqual(t, len(swept.Entries), 0, "content entries after a deletion")
	harness.AssertEqual(t, swept.CurrentEpoch, int64(2), "the content epoch after a deletion")
}
