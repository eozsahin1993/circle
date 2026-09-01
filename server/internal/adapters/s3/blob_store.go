// Package s3 implements ports.BlobStore against a single S3 bucket, using
// presigned URLs so ciphertext bytes never pass through Lambda — see
// server/DESIGN.md.
package s3

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"circle-relay/internal/ports"
)

const (
	uploadURLTTL   = 15 * time.Minute
	downloadURLTTL = time.Hour

	// DefaultMaxBlobSize caps a single blob's ciphertext size — see
	// server/DESIGN.md. The client's own compression pipeline
	// (app/src/services/image.ts: 1080px longest edge, JPEG quality 0.65)
	// produces photos well under this in practice (typically 150KB-1MB);
	// the cap leaves real headroom while still bounding worst-case
	// storage/cost from a client that bypasses that pipeline.
	DefaultMaxBlobSize = 2 * 1024 * 1024

	// blobContentType is pinned on every upload — the relay can't know
	// the plaintext's real type (it's encrypted), so this isn't a
	// detected value, it's a fixed placeholder the client is required to
	// echo back. Prevents a malicious or buggy client from tagging an
	// object as e.g. text/html, which would matter if a download URL
	// were ever opened directly in a browser.
	blobContentType = "application/octet-stream"
)

type BlobStore struct {
	presignClient *s3.PresignClient
	bucketName    string
	maxBlobSize   int64
}

func NewBlobStore(client *s3.Client, bucketName string, maxBlobSize int64) *BlobStore {
	if maxBlobSize <= 0 {
		maxBlobSize = DefaultMaxBlobSize
	}
	return &BlobStore{presignClient: s3.NewPresignClient(client), bucketName: bucketName, maxBlobSize: maxBlobSize}
}

var _ ports.BlobStore = (*BlobStore)(nil)

// GetUploadTarget signs a POST policy with a content-length-range
// condition and a pinned Content-Type, so S3 itself rejects an oversized
// or mistyped upload at the point it happens — nothing after the fact has
// to check or clean it up. Unlike Key, ContentType on PutObjectInput isn't
// picked up by PresignPostObject on its own (verified: it neither adds a
// policy condition nor a Fields entry) — both have to be added explicitly.
func (b *BlobStore) GetUploadTarget(ctx context.Context, circleLogID string, epoch int64) (ports.UploadTarget, error) {
	req, err := b.presignClient.PresignPostObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(b.bucketName),
		Key:    aws.String(blobKey(circleLogID, epoch)),
	}, func(o *s3.PresignPostOptions) {
		o.Expires = uploadURLTTL
		o.Conditions = []any{
			[]any{"content-length-range", 1, b.maxBlobSize},
			map[string]any{"Content-Type": blobContentType},
		}
	})
	if err != nil {
		return ports.UploadTarget{}, err
	}
	req.Values["Content-Type"] = blobContentType
	return ports.UploadTarget{URL: req.URL, Fields: req.Values}, nil
}

func (b *BlobStore) GetDownloadURL(ctx context.Context, circleLogID string, epoch int64) (string, error) {
	req, err := b.presignClient.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(b.bucketName),
		Key:    aws.String(blobKey(circleLogID, epoch)),
	}, s3.WithPresignExpires(downloadURLTTL))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

// blobKey is the deterministic object key both sides compute independently
// — see server/DESIGN.md: "the S3 object key just *is*
// ${circleLogId}/${epoch}", never a separately-issued token.
func blobKey(circleLogID string, epoch int64) string {
	return fmt.Sprintf("%s/%d", circleLogID, epoch)
}
