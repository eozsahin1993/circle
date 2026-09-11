// Package circleerrors maps logstore's sentinel errors to HTTP status
// codes — shared by every vertical slice under /circles/ so the mapping
// lives in one place rather than drifting across handler.go files.
package circleerrors

import (
	"errors"
	"log"
	"net/http"

	"circle-relay/internal/storage/blobstore"
	"circle-relay/internal/storage/logstore"
)

// Status returns the HTTP status and a client-safe message for err. Falls
// back to 500 for anything not specifically a logstore sentinel — an
// unrecognized error is a bug or a backend outage, not something to guess
// a 4xx for.
func Status(err error) (int, string) {
	switch {
	case errors.Is(err, logstore.ErrCircleNotFound):
		return http.StatusNotFound, "circle not found"
	case errors.Is(err, logstore.ErrAlreadyExists):
		return http.StatusConflict, "circle already exists"
	case errors.Is(err, logstore.ErrInvalidNamespace):
		return http.StatusBadRequest, "invalid namespace"
	case errors.Is(err, logstore.ErrWriteTokenMismatch):
		// Deliberately the same status/message whether the caller was
		// never a member or just has a stale token from before a
		// rotation — the relay only ever verifies possession of the
		// current write token, never who someone is, so it isn't in a
		// position to tell those apart, and shouldn't try to.
		return http.StatusForbidden, "write token does not match current circle state"
	case errors.Is(err, logstore.ErrAuthorityNotRecognized):
		return http.StatusForbidden, "authority key not recognized for this circle"
	case errors.Is(err, logstore.ErrInvalidAuthorityAction):
		return http.StatusBadRequest, "authority action must be add or remove"
	case errors.Is(err, logstore.ErrInvalidAuthorityKey):
		return http.StatusBadRequest, "authority key must be a hex-encoded ed25519 public key"
	case errors.Is(err, logstore.ErrWouldEmptyAuthoritySet):
		return http.StatusConflict, "that would leave the circle with no admin the relay recognizes"
	case errors.Is(err, logstore.ErrInvalidSignature):
		return http.StatusBadRequest, "signature does not verify"
	case errors.Is(err, logstore.ErrCircleDeleted):
		return http.StatusGone, "circle has been deleted"
	case errors.Is(err, logstore.ErrConcurrentModification):
		return http.StatusConflict, "circle state changed concurrently, retry"
	case errors.Is(err, blobstore.ErrBlobAlreadyExists):
		// Not necessarily an attack — also what a legitimate retry sees
		// after a successful upload the caller never heard back from. See
		// blobstore.Store.GetUploadTarget's doc comment.
		return http.StatusConflict, "a blob already exists for this entry"
	default:
		// The response can't carry the reason (it may name internals), and
		// the request log only records the status — so an unmapped error is
		// otherwise a 500 with no way to find out what happened.
		log.Printf("unmapped error, returning 500: %v", err)
		return http.StatusInternalServerError, "internal error"
	}
}
