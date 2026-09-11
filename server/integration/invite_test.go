package integration_test

import (
	"fmt"
	"net/http"
	"testing"
)

// The invite mailbox, end to end — see server/INVITE_FLOW.md. Every test
// here is a sequence, because that's where the flow's real behaviour
// lives: a request that outlives its approval, an approval readable after
// a dismissal, a tag that still answers once its rows are gone.

// The routes below are written as the flow's own vocabulary, so a test
// reads as the steps someone takes rather than as method-and-path, and
// each path is spelled out once.

func invitePath(tag string) string { return "/v1/invites/" + tag }

func requestPath(tag, requester string) string {
	return fmt.Sprintf("/v1/invites/%s/requests/%s", tag, requester)
}

// createInvite mints an invite and returns its tag.
func (d *device) createInvite() string {
	tag := suffix()
	d.put(invitePath(tag), body{"encryptedPreview": ciphertext()}).expect(http.StatusOK)
	return tag
}

func (d *device) readInvite(tag string) response {
	return d.get(invitePath(tag))
}

func (d *device) askToJoin(tag, requester string) response {
	return d.put(requestPath(tag, requester), body{"encryptedRequest": ciphertext()})
}

func (d *device) approve(tag, requester, approval string) response {
	return d.put(requestPath(tag, requester)+"/approval", body{"encryptedApproval": approval})
}

func (d *device) dismiss(tag, requester string) response {
	return d.remove(requestPath(tag, requester))
}

func (d *device) readRequest(tag, requester string) response {
	return d.get(requestPath(tag, requester))
}

// requestRow is one row as the relay hands it back. EncryptedApproval is a
// pointer because nil and empty mean different things: nobody has
// approved, versus approved with nothing in it.
type requestRow struct {
	RequesterID       string
	EncryptedRequest  string
	EncryptedApproval *string
}

// pendingRequests is the creator's view of one invite's mailbox.
func (d *device) pendingRequests(tag string) []requestRow {
	var listed struct{ Requests []requestRow }
	d.get(invitePath(tag) + "/requests").expect(http.StatusOK).decode(&listed)
	return listed.Requests
}

func TestInviteIsReadableByWhoeverHoldsTheTag(t *testing.T) {
	r := start(t)
	tag := r.signIn().createInvite()

	// A stranger with a session, not the creator: the tag *is* the
	// capability (INVITE_FLOW.md), so the relay must not care who asks.
	// It never learns who is inviting whom.
	var preview struct{ EncryptedPreview string }
	r.signIn().readInvite(tag).expect(http.StatusOK).decode(&preview)

	assertTrue(t, preview.EncryptedPreview != "", "the invite came back with no preview")
}

func TestAnUnknownInviteTagIsNotFound(t *testing.T) {
	r := start(t)

	r.signIn().readInvite(suffix()).expect(http.StatusNotFound)
}

func TestTheInviteFlowIsSessionGated(t *testing.T) {
	r := start(t)
	tag := r.signIn().createInvite()

	// Not because the relay knows who should read an invite — it doesn't —
	// but because no /invites/ route is reachable without a session at
	// all. Worth pinning: the tag is a capability, and an unauthenticated
	// caller who guessed one would otherwise be able to use it.
	r.anon().readInvite(tag).expect(http.StatusUnauthorized)
}

func TestRequestThenApproveThenRead(t *testing.T) {
	r := start(t)
	creator, joiner := r.signIn(), r.signIn()
	tag := creator.createInvite()
	requester := suffix()

	joiner.askToJoin(tag, requester).expect(http.StatusOK)

	pending := creator.pendingRequests(tag)
	assertEqual(t, "pending requests", len(pending), 1)
	assertEqual(t, "the pending requester", pending[0].RequesterID, requester)
	assertTrue(t, pending[0].EncryptedApproval == nil, "a request nobody approved came back with an approval")

	approval := ciphertext()
	creator.approve(tag, requester, approval).expect(http.StatusOK)

	// The joiner collects it. This is the handoff the whole flow exists
	// for, and the only step where the joiner reads rather than writes.
	var collected requestRow
	joiner.readRequest(tag, requester).expect(http.StatusOK).decode(&collected)

	assertTrue(t, collected.EncryptedApproval != nil, "the approval never reached the joiner")
	assertEqual(t, "the collected approval", *collected.EncryptedApproval, approval)
}

func TestApprovingSomethingNobodyAskedForIsNotFound(t *testing.T) {
	r := start(t)
	creator := r.signIn()
	tag := creator.createInvite()

	// Approval updates a row in place, so with no request there is nothing
	// to update — and it must not conjure one. A created-from-nothing
	// approval would be an admission the requester never made.
	creator.approve(tag, suffix(), ciphertext()).expect(http.StatusNotFound)
}

func TestDismissingARequestRemovesIt(t *testing.T) {
	r := start(t)
	creator := r.signIn()
	tag := creator.createInvite()
	requester := suffix()

	creator.askToJoin(tag, requester).expect(http.StatusOK)
	creator.dismiss(tag, requester).expect(http.StatusOK)

	creator.readRequest(tag, requester).expect(http.StatusNotFound)
	assertEqual(t, "requests left after a dismissal", len(creator.pendingRequests(tag)), 0)
}

func TestADismissedRequestCannotBeApproved(t *testing.T) {
	r := start(t)
	creator := r.signIn()
	tag := creator.createInvite()
	requester := suffix()

	creator.askToJoin(tag, requester).expect(http.StatusOK)
	creator.dismiss(tag, requester).expect(http.StatusOK)

	// The sequence that matters: dismissing then approving must not
	// resurrect the row. If it did, a decision already taken would be
	// silently reversed by a late approval.
	creator.approve(tag, requester, ciphertext()).expect(http.StatusNotFound)
}

func TestDismissingIsIdempotent(t *testing.T) {
	r := start(t)
	creator := r.signIn()
	tag := creator.createInvite()
	requester := suffix()

	creator.askToJoin(tag, requester).expect(http.StatusOK)

	// Twice, then once more for a request that never existed. A client
	// retrying a dismissal it isn't sure landed shouldn't see an error.
	creator.dismiss(tag, requester).expect(http.StatusOK)
	creator.dismiss(tag, requester).expect(http.StatusOK)
	creator.dismiss(tag, suffix()).expect(http.StatusOK)
}

func TestARepeatedRequestIsAnIdempotentRetry(t *testing.T) {
	r := start(t)
	creator, joiner := r.signIn(), r.signIn()
	tag := creator.createInvite()
	requester := suffix()

	joiner.askToJoin(tag, requester).expect(http.StatusOK)
	first := creator.pendingRequests(tag)[0].EncryptedRequest

	// Same requester id, fresh payload. A requester id is randomly chosen,
	// so this can only be a retry of one submission — and it must converge
	// rather than error, or a joiner unsure whether their request landed
	// has no safe move.
	joiner.askToJoin(tag, requester).expect(http.StatusOK)

	after := creator.pendingRequests(tag)
	assertEqual(t, "rows after a retry", len(after), 1)
	// The first payload wins, deliberately: the creator may already have
	// sealed an approval to the ephemeral key in it, and letting a later
	// PUT swap the payload would strand that approval against a key the
	// joiner no longer holds.
	assertEqual(t, "the surviving request", after[0].EncryptedRequest, first)
}

func TestRequestsAreScopedToTheirInvite(t *testing.T) {
	r := start(t)
	creator := r.signIn()
	mine, theirs := creator.createInvite(), creator.createInvite()
	requester := suffix()

	creator.askToJoin(mine, requester).expect(http.StatusOK)

	// Same requester id, different tag: the row belongs to one invite and
	// must not be visible through another. Requester ids are client-chosen,
	// so this is the boundary stopping one invite's mailbox leaking into
	// the next.
	creator.readRequest(theirs, requester).expect(http.StatusNotFound)
	assertEqual(t, "requests under the other invite", len(creator.pendingRequests(theirs)), 0)
}

func TestARequestNeedsNoInviteToExist(t *testing.T) {
	r := start(t)

	// Documents what happens today rather than asserting a rule: the
	// mailbox is keyed by tag, and nothing checks the invite row is there
	// first. A request against a tag nobody minted is accepted and simply
	// has no reader. If that ever becomes a 404, this test says so.
	r.signIn().askToJoin(suffix(), suffix()).expect(http.StatusOK)
}

func TestAMissingOrMalformedFieldIsRejected(t *testing.T) {
	r := start(t)
	d := r.signIn()
	tag := suffix()

	cases := []struct {
		what  string
		path  string
		field string
	}{
		{"invite", invitePath(tag), "encryptedPreview"},
		{"request", requestPath(tag, suffix()), "encryptedRequest"},
	}

	for _, c := range cases {
		t.Run(c.what+" missing", func(t *testing.T) {
			d.put(c.path, body{}).expect(http.StatusBadRequest)
		})
		t.Run(c.what+" not base64", func(t *testing.T) {
			d.put(c.path, body{c.field: "not base64!"}).expect(http.StatusBadRequest)
		})
	}
}
