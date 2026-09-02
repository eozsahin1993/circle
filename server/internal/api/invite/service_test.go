package invite_test

import (
	"context"
	"errors"
	"testing"

	"circle-relay/internal/api/invite"
	"circle-relay/internal/storage/invitestore"
	"circle-relay/internal/testsupport"
)

func TestService_CreateInviteThenGetInvite_RoundTrips(t *testing.T) {
	ctx := context.Background()
	svc := &invite.Service{InviteStore: testsupport.NewInviteStore(t, 0)}
	inviteTag := testsupport.UniqueInviteTag(t)
	preview := []byte("pretend-encrypted-preview")

	if err := svc.CreateInvite(ctx, inviteTag, preview); err != nil {
		t.Fatal(err)
	}

	got, err := svc.GetInvite(ctx, inviteTag)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(preview) {
		t.Fatalf("expected %q, got %q", preview, got)
	}
}

func TestService_GetInvite_ReturnsNilForATagThatWasNeverCreated(t *testing.T) {
	ctx := context.Background()
	svc := &invite.Service{InviteStore: testsupport.NewInviteStore(t, 0)}

	got, err := svc.GetInvite(ctx, testsupport.UniqueInviteTag(t))
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("expected nil, got %q", got)
	}
}

func TestService_PutRequestThenGetRequest_RoundTrips(t *testing.T) {
	ctx := context.Background()
	svc := &invite.Service{InviteStore: testsupport.NewInviteStore(t, 0)}
	inviteTag := testsupport.UniqueInviteTag(t)
	requesterID := "requester-1"
	encryptedRequest := []byte("pretend-encrypted-join-request")

	if err := svc.PutRequest(ctx, inviteTag, requesterID, encryptedRequest); err != nil {
		t.Fatal(err)
	}

	got, err := svc.GetRequest(ctx, inviteTag, requesterID)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("expected a non-nil join request")
	}
	if got.RequesterID != requesterID {
		t.Fatalf("expected requesterID %q, got %q", requesterID, got.RequesterID)
	}
	if string(got.EncryptedRequest) != string(encryptedRequest) {
		t.Fatalf("expected encryptedRequest %q, got %q", encryptedRequest, got.EncryptedRequest)
	}
	if got.EncryptedApproval != nil {
		t.Fatalf("expected no approval yet, got %q", got.EncryptedApproval)
	}
}

func TestService_GetRequest_ReturnsNilForARequesterThatNeverSubmitted(t *testing.T) {
	ctx := context.Background()
	svc := &invite.Service{InviteStore: testsupport.NewInviteStore(t, 0)}

	got, err := svc.GetRequest(ctx, testsupport.UniqueInviteTag(t), "nobody")
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("expected nil, got %+v", got)
	}
}

func TestService_ListRequests_ReturnsEveryRequesterUnderOneInvite(t *testing.T) {
	ctx := context.Background()
	svc := &invite.Service{InviteStore: testsupport.NewInviteStore(t, 0)}
	inviteTag := testsupport.UniqueInviteTag(t)

	if err := svc.PutRequest(ctx, inviteTag, "requester-a", []byte("request-a")); err != nil {
		t.Fatal(err)
	}
	if err := svc.PutRequest(ctx, inviteTag, "requester-b", []byte("request-b")); err != nil {
		t.Fatal(err)
	}
	// A request under a different invite must not show up here.
	if err := svc.PutRequest(ctx, testsupport.UniqueInviteTag(t), "requester-c", []byte("request-c")); err != nil {
		t.Fatal(err)
	}

	got, err := svc.ListRequests(ctx, inviteTag)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 requests, got %d: %+v", len(got), got)
	}
	seen := map[string]bool{}
	for _, jr := range got {
		seen[jr.RequesterID] = true
	}
	if !seen["requester-a"] || !seen["requester-b"] {
		t.Fatalf("expected requester-a and requester-b, got %+v", got)
	}
}

func TestService_PutRequest_DuplicateSubmissionDoesNotError(t *testing.T) {
	ctx := context.Background()
	svc := &invite.Service{InviteStore: testsupport.NewInviteStore(t, 0)}
	inviteTag := testsupport.UniqueInviteTag(t)
	requesterID := "requester-1"

	if err := svc.PutRequest(ctx, inviteTag, requesterID, []byte("first-submission")); err != nil {
		t.Fatal(err)
	}
	// A retry of the same requesterID must converge, not error — same
	// idempotent-retry contract as logstore.Store.CommitEntry.
	if err := svc.PutRequest(ctx, inviteTag, requesterID, []byte("first-submission")); err != nil {
		t.Fatalf("expected duplicate PutRequest to succeed idempotently, got %v", err)
	}

	got, err := svc.GetRequest(ctx, inviteTag, requesterID)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("expected a non-nil join request")
	}
	if string(got.EncryptedRequest) != "first-submission" {
		t.Fatalf("expected the original submission to survive the retry, got %q", got.EncryptedRequest)
	}
}

func TestService_PutApprovalThenGetRequest_ShowsApproval(t *testing.T) {
	ctx := context.Background()
	svc := &invite.Service{InviteStore: testsupport.NewInviteStore(t, 0)}
	inviteTag := testsupport.UniqueInviteTag(t)
	requesterID := "requester-1"
	approval := []byte("pretend-sealed-box-approval")

	if err := svc.PutRequest(ctx, inviteTag, requesterID, []byte("pretend-encrypted-join-request")); err != nil {
		t.Fatal(err)
	}
	if err := svc.PutApproval(ctx, inviteTag, requesterID, approval); err != nil {
		t.Fatal(err)
	}

	got, err := svc.GetRequest(ctx, inviteTag, requesterID)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("expected a non-nil join request")
	}
	if string(got.EncryptedApproval) != string(approval) {
		t.Fatalf("expected approval %q, got %q", approval, got.EncryptedApproval)
	}
}

func TestService_PutApproval_ErrorsForANonexistentRequest(t *testing.T) {
	ctx := context.Background()
	svc := &invite.Service{InviteStore: testsupport.NewInviteStore(t, 0)}

	err := svc.PutApproval(ctx, testsupport.UniqueInviteTag(t), "nobody", []byte("approval"))
	if err == nil {
		t.Fatal("expected an error approving a join request that was never made")
	}
	if !errors.Is(err, invitestore.ErrJoinRequestNotFound) {
		t.Fatalf("expected ErrJoinRequestNotFound, got %v", err)
	}
}
