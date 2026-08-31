package ports

import "context"

// BlobStore is storage for the (large, encrypted) blob behind one log
// entry. Presigned URLs generated here always succeed and cost nothing to
// hand out — they're pure local signing, not a network call — so callers
// are never expected to check "does this entry actually have a blob"
// first; see server/DESIGN.md's "deciding whether to fetch a blob is
// entirely client-side" note.
type BlobStore interface {
	// GetUploadURL returns a short-lived URL the client can PUT
	// ciphertext bytes to for this exact entry.
	GetUploadURL(ctx context.Context, circleLogID string, epoch int64) (string, error)

	// GetDownloadURL returns a short-lived URL the client can GET
	// ciphertext bytes from. It 404s on use if nothing was ever uploaded
	// there — that's expected, not an error here.
	GetDownloadURL(ctx context.Context, circleLogID string, epoch int64) (string, error)
}
