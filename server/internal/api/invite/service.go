// Package invite is the vertical slice for the invite/join-request
// routes under /invites/ — see server/INVITE_FLOW.md for the full
// design. Flat, not nested under api/account: this isn't account-scoped
// data, it's tag-addressed (by invite tag) exactly like the "mailbox"
// concept server/DESIGN.md's "Mailbox" section describes — invites are
// its first consumer, not its only intended one. The relay only ever
// stores and returns ciphertext; nothing here looks inside it.
package invite

import (
	"context"

	"circle-relay/internal/storage/invitestore"
)

type Service struct {
	InviteStore invitestore.Store
}

// CreateInvite writes the sk="invite" row for inviteTag — the one
// proactive server write in the whole flow, done once at invite-creation
// time.
func (s *Service) CreateInvite(ctx context.Context, inviteTag string, encryptedPreview []byte) error {
	return s.InviteStore.CreateInvite(ctx, inviteTag, encryptedPreview)
}

// GetInvite returns nil, nil if inviteTag has no invite row.
func (s *Service) GetInvite(ctx context.Context, inviteTag string) ([]byte, error) {
	return s.InviteStore.GetInvite(ctx, inviteTag)
}

// PutRequest creates the requester's row if it doesn't already exist —
// idempotent, safe to retry.
func (s *Service) PutRequest(ctx context.Context, inviteTag, requesterID string, encryptedRequest []byte) error {
	return s.InviteStore.PutJoinRequest(ctx, inviteTag, requesterID, encryptedRequest)
}

// ListRequests returns every request row under inviteTag, for the
// invite's creator to scan for new/approved requests.
func (s *Service) ListRequests(ctx context.Context, inviteTag string) ([]invitestore.JoinRequest, error) {
	return s.InviteStore.ListJoinRequests(ctx, inviteTag)
}

// GetRequest returns nil, nil if requesterID has no row under inviteTag.
func (s *Service) GetRequest(ctx context.Context, inviteTag, requesterID string) (*invitestore.JoinRequest, error) {
	return s.InviteStore.GetJoinRequest(ctx, inviteTag, requesterID)
}

// PutApproval sets the sealed-box-encrypted approval payload on an
// existing request row — errors if the row doesn't exist.
func (s *Service) PutApproval(ctx context.Context, inviteTag, requesterID string, encryptedApproval []byte) error {
	return s.InviteStore.ApproveJoinRequest(ctx, inviteTag, requesterID, encryptedApproval)
}

// DeleteRequest removes a requester's row — "not now". Idempotent.
func (s *Service) DeleteRequest(ctx context.Context, inviteTag, requesterID string) error {
	return s.InviteStore.DeleteJoinRequest(ctx, inviteTag, requesterID)
}
