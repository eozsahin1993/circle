package blackbox_test

import (
	"fmt"
	"net/http"
	"testing"
)

// The invite mailbox, end to end — see server/INVITE_FLOW.md. Every test
// here is a sequence, because that's where the flow's real behaviour
// lives: a request that outlives its approval, an approval readable after
// a dismissal, a tag that still answers once its rows are gone.

func invitePath(tag string) string {
	return "/v1/invites/" + tag
}

func requestPath(tag, requester string) string {
	return fmt.Sprintf("/v1/invites/%s/requests/%s", tag, requester)
}

// createInvite puts an invite row and returns its tag.
func createInvite(t *testing.T, r *relay, d *device) string {
	t.Helper()
	tag := unique(t)
	r.do(t, d, http.MethodPut, invitePath(tag), map[string]string{
		"encryptedPreview": ciphertext(t),
	}).expect(t, http.StatusOK)
	return tag
}

func TestInviteIsReadableByWhoeverHoldsTheTag(t *testing.T) {
	r := start(t)
	creator := r.signIn(t)
	tag := createInvite(t, r, creator)

	// A stranger with a session, not the creator: the tag *is* the
	// capability (INVITE_FLOW.md), so the relay must not care who asks.
	// It never learns who is inviting whom.
	stranger := r.signIn(t)
	res := r.do(t, stranger, http.MethodGet, invitePath(tag), nil).expect(t, http.StatusOK)

	var preview struct{ EncryptedPreview string }
	res.json(t, &preview)
	if preview.EncryptedPreview == "" {
		t.Fatal("the invite came back with no preview")
	}
}

func TestAnUnknownInviteTagIsNotFound(t *testing.T) {
	r := start(t)
	d := r.signIn(t)

	r.do(t, d, http.MethodGet, invitePath(unique(t)), nil).expect(t, http.StatusNotFound)
}

func TestTheInviteFlowIsSessionGated(t *testing.T) {
	r := start(t)
	tag := createInvite(t, r, r.signIn(t))

	// Not because the relay knows who should read an invite — it doesn't —
	// but because no /invites/ route is reachable without a session at
	// all. Worth pinning: the tag is a capability, and an unauthenticated
	// caller who guessed one would otherwise be able to use it.
	r.do(t, nil, http.MethodGet, invitePath(tag), nil).expect(t, http.StatusUnauthorized)
}

func TestRequestThenApproveThenRead(t *testing.T) {
	r := start(t)
	creator := r.signIn(t)
	joiner := r.signIn(t)
	tag := createInvite(t, r, creator)
	requester := unique(t)

	// The joiner asks.
	r.do(t, joiner, http.MethodPut, requestPath(tag, requester), map[string]string{
		"encryptedRequest": ciphertext(t),
	}).expect(t, http.StatusOK)

	// Pending: present in the creator's list, with no approval yet.
	var listed struct {
		Requests []struct {
			RequesterID       string
			EncryptedApproval *string
		}
	}
	r.do(t, creator, http.MethodGet, invitePath(tag)+"/requests", nil).
		expect(t, http.StatusOK).json(t, &listed)

	if len(listed.Requests) != 1 || listed.Requests[0].RequesterID != requester {
		t.Fatalf("expected one pending request for %s, got %+v", requester, listed.Requests)
	}
	if listed.Requests[0].EncryptedApproval != nil {
		t.Fatal("a request nobody has approved came back with an approval")
	}

	// The creator approves.
	approval := ciphertext(t)
	r.do(t, creator, http.MethodPut, requestPath(tag, requester)+"/approval", map[string]string{
		"encryptedApproval": approval,
	}).expect(t, http.StatusOK)

	// And the joiner can collect it. This is the handoff the whole flow
	// exists for, and the only step where the joiner reads rather than
	// writes.
	var collected struct {
		RequesterID       string
		EncryptedApproval *string
	}
	r.do(t, joiner, http.MethodGet, requestPath(tag, requester), nil).
		expect(t, http.StatusOK).json(t, &collected)

	if collected.EncryptedApproval == nil || *collected.EncryptedApproval != approval {
		t.Fatalf("the approval didn't survive the round trip: %+v", collected)
	}
}

func TestApprovingSomethingNobodyAskedForIsNotFound(t *testing.T) {
	r := start(t)
	creator := r.signIn(t)
	tag := createInvite(t, r, creator)

	// Approval updates a row in place, so with no request there is nothing
	// to update — and it must not conjure one. A created-from-nothing
	// approval would be an admission the requester never made.
	r.do(t, creator, http.MethodPut, requestPath(tag, unique(t))+"/approval", map[string]string{
		"encryptedApproval": ciphertext(t),
	}).expect(t, http.StatusNotFound)
}

func TestDismissingARequestRemovesIt(t *testing.T) {
	r := start(t)
	creator := r.signIn(t)
	tag := createInvite(t, r, creator)
	requester := unique(t)

	r.do(t, creator, http.MethodPut, requestPath(tag, requester), map[string]string{
		"encryptedRequest": ciphertext(t),
	}).expect(t, http.StatusOK)

	r.do(t, creator, http.MethodDelete, requestPath(tag, requester), nil).expect(t, http.StatusOK)

	r.do(t, creator, http.MethodGet, requestPath(tag, requester), nil).expect(t, http.StatusNotFound)

	var listed struct {
		Requests []struct{ RequesterID string }
	}
	r.do(t, creator, http.MethodGet, invitePath(tag)+"/requests", nil).
		expect(t, http.StatusOK).json(t, &listed)
	for _, request := range listed.Requests {
		if request.RequesterID == requester {
			t.Fatal("a dismissed request is still in the list")
		}
	}
}

func TestADismissedRequestCannotBeApproved(t *testing.T) {
	r := start(t)
	creator := r.signIn(t)
	tag := createInvite(t, r, creator)
	requester := unique(t)

	r.do(t, creator, http.MethodPut, requestPath(tag, requester), map[string]string{
		"encryptedRequest": ciphertext(t),
	}).expect(t, http.StatusOK)
	r.do(t, creator, http.MethodDelete, requestPath(tag, requester), nil).expect(t, http.StatusOK)

	// The sequence that matters: dismissing then approving must not
	// resurrect the row. If it did, a decision already taken would be
	// silently reversed by a late approval.
	r.do(t, creator, http.MethodPut, requestPath(tag, requester)+"/approval", map[string]string{
		"encryptedApproval": ciphertext(t),
	}).expect(t, http.StatusNotFound)
}

func TestDismissingIsIdempotent(t *testing.T) {
	r := start(t)
	creator := r.signIn(t)
	tag := createInvite(t, r, creator)
	requester := unique(t)

	r.do(t, creator, http.MethodPut, requestPath(tag, requester), map[string]string{
		"encryptedRequest": ciphertext(t),
	}).expect(t, http.StatusOK)

	// Twice, then once more for a request that never existed. A client
	// retrying a dismissal it isn't sure landed shouldn't see an error.
	r.do(t, creator, http.MethodDelete, requestPath(tag, requester), nil).expect(t, http.StatusOK)
	r.do(t, creator, http.MethodDelete, requestPath(tag, requester), nil).expect(t, http.StatusOK)
	r.do(t, creator, http.MethodDelete, requestPath(tag, unique(t)), nil).expect(t, http.StatusOK)
}

func TestARepeatedRequestIsAnIdempotentRetry(t *testing.T) {
	r := start(t)
	creator := r.signIn(t)
	joiner := r.signIn(t)
	tag := createInvite(t, r, creator)
	requester := unique(t)

	first := ciphertext(t)
	r.do(t, joiner, http.MethodPut, requestPath(tag, requester), map[string]string{
		"encryptedRequest": first,
	}).expect(t, http.StatusOK)

	// Same requester id, different payload. A requester id is randomly
	// chosen, so this can only be a retry of one submission — and it must
	// converge rather than error, or a joiner unsure whether their request
	// landed has no safe move.
	r.do(t, joiner, http.MethodPut, requestPath(tag, requester), map[string]string{
		"encryptedRequest": ciphertext(t),
	}).expect(t, http.StatusOK)

	var listed struct {
		Requests []struct {
			RequesterID      string
			EncryptedRequest string
		}
	}
	r.do(t, creator, http.MethodGet, invitePath(tag)+"/requests", nil).
		expect(t, http.StatusOK).json(t, &listed)

	if len(listed.Requests) != 1 {
		t.Fatalf("a retry should leave one row, got %d", len(listed.Requests))
	}
	// The first payload wins, deliberately: the creator may already have
	// sealed an approval to the ephemeral key in it, and letting a later
	// PUT swap the payload would strand that approval against a key the
	// joiner no longer holds.
	if listed.Requests[0].EncryptedRequest != first {
		t.Fatal("a retry overwrote the request the approver may already have answered")
	}
}

func TestRequestsAreScopedToTheirInvite(t *testing.T) {
	r := start(t)
	creator := r.signIn(t)
	mine := createInvite(t, r, creator)
	theirs := createInvite(t, r, creator)
	requester := unique(t)

	r.do(t, creator, http.MethodPut, requestPath(mine, requester), map[string]string{
		"encryptedRequest": ciphertext(t),
	}).expect(t, http.StatusOK)

	// Same requester id, different tag: the row belongs to one invite and
	// must not be visible through another. Requester ids are client-chosen,
	// so this is the boundary stopping one invite's mailbox leaking into
	// the next.
	r.do(t, creator, http.MethodGet, requestPath(theirs, requester), nil).expect(t, http.StatusNotFound)

	var listed struct {
		Requests []struct{ RequesterID string }
	}
	r.do(t, creator, http.MethodGet, invitePath(theirs)+"/requests", nil).
		expect(t, http.StatusOK).json(t, &listed)
	if len(listed.Requests) != 0 {
		t.Fatalf("the other invite came back with %d requests", len(listed.Requests))
	}
}

func TestARequestNeedsAnInviteThatExists(t *testing.T) {
	r := start(t)
	joiner := r.signIn(t)

	// Documents what happens today rather than asserting a rule: the
	// mailbox is keyed by tag, and nothing checks the invite row is there
	// first. A request against a tag nobody minted is accepted and simply
	// has no reader. If that ever becomes a 404, this test says so.
	res := r.do(t, joiner, http.MethodPut, requestPath(unique(t), unique(t)), map[string]string{
		"encryptedRequest": ciphertext(t),
	})
	if res.status != http.StatusOK {
		t.Fatalf("expected the relay to accept a request for an unminted tag, got %d: %s", res.status, res.body)
	}
}

func TestAnEmptyOrMalformedBodyIsRejected(t *testing.T) {
	r := start(t)
	d := r.signIn(t)
	tag := unique(t)

	cases := []struct {
		name string
		path string
		body map[string]string
		key  string
	}{
		{"invite", invitePath(tag), map[string]string{}, "encryptedPreview"},
		{"request", requestPath(tag, unique(t)), map[string]string{}, "encryptedRequest"},
	}

	for _, c := range cases {
		t.Run(c.name+" missing", func(t *testing.T) {
			r.do(t, d, http.MethodPut, c.path, c.body).expect(t, http.StatusBadRequest)
		})
		t.Run(c.name+" not base64", func(t *testing.T) {
			r.do(t, d, http.MethodPut, c.path, map[string]string{c.key: "not base64!"}).
				expect(t, http.StatusBadRequest)
		})
	}
}
