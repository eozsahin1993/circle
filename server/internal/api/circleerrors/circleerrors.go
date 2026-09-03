// Package circleerrors maps logstore's sentinel errors to HTTP status
// codes — shared by every vertical slice under /circles/ so the mapping
// lives in one place rather than drifting across handler.go files.
package circleerrors

import (
	"errors"
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
		// rotation — see server/SYNC_DESIGN.md's "possession, not
		// identity" principle; the relay isn't in a position to tell
		// those apart, and shouldn't try to.
		return http.StatusForbidden, "write token does not match current circle state"
	case errors.Is(err, logstore.ErrAuthorityNotRecognized):
		return http.StatusForbidden, "authority key not recognized for this circle"
	case errors.Is(err, logstore.ErrInvalidSignature):
		return http.StatusBadRequest, "signature does not verify"
	case errors.Is(err, logstore.ErrConcurrentModification):
		return http.StatusConflict, "circle state changed concurrently, retry"
	case errors.Is(err, blobstore.ErrBlobAlreadyExists):
		// Not necessarily an attack — also what a legitimate retry sees
		// after a successful upload the caller never heard back from. See
		// blobstore.Store.GetUploadTarget's doc comment.
		return http.StatusConflict, "a blob already exists for this entry"
	default:
		return http.StatusInternalServerError, "internal error"
	}
}
