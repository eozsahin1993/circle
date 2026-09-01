package ports

import "context"

// UploadTarget is a presigned S3 POST (URL plus required form fields), not
// a bare PUT URL — a POST policy is what lets the max blob size be
// enforced by S3 itself via a signed content-length-range condition,
// instead of trusting the client or checking after the fact.
type UploadTarget struct {
	URL    string
	Fields map[string]string
}

// BlobStore is storage for the (large, encrypted) blob behind one log
// entry. Presigned URLs generated here always succeed and cost nothing to
// hand out — they're pure local signing, not a network call — so callers
// are never expected to check "does this entry actually have a blob"
// first; see server/DESIGN.md's "deciding whether to fetch a blob is
// entirely client-side" note.
type BlobStore interface {
	// GetUploadTarget returns a short-lived presigned POST the client can
	// send ciphertext bytes to for this exact entry, capped at the
	// store's configured max blob size.
	GetUploadTarget(ctx context.Context, circleLogID string, epoch int64) (UploadTarget, error)

	// GetDownloadURL returns a short-lived URL the client can GET
	// ciphertext bytes from. It 404s on use if nothing was ever uploaded
	// there — that's expected, not an error here.
	GetDownloadURL(ctx context.Context, circleLogID string, epoch int64) (string, error)
}
