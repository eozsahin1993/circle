// Package s3 implements blobstore.Store against a single S3 bucket, using
// presigned URLs so ciphertext bytes never pass through Lambda — see
// server/DESIGN.md.
package s3

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"

	"circle-relay/internal/storage/blobstore"
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

type Store struct {
	client        *s3.Client
	presignClient *s3.PresignClient
	bucketName    string
	maxBlobSize   int64
}

func New(client *s3.Client, bucketName string, maxBlobSize int64) *Store {
	if maxBlobSize <= 0 {
		maxBlobSize = DefaultMaxBlobSize
	}
	return &Store{client: client, presignClient: s3.NewPresignClient(client), bucketName: bucketName, maxBlobSize: maxBlobSize}
}

var _ blobstore.Store = (*Store)(nil)

// GetUploadTarget checks for an existing object first (see the interface
// doc for why), then signs a POST policy with a content-length-range
// condition and a pinned Content-Type, so S3 itself rejects an oversized
// or mistyped upload. Unlike Key, ContentType on PutObjectInput isn't
// picked up by PresignPostObject on its own — both need adding explicitly.
func (s *Store) GetUploadTarget(ctx context.Context, circleLogID, entryID string) (blobstore.UploadTarget, error) {
	key := blobKey(circleLogID, entryID)
	_, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(s.bucketName), Key: aws.String(key)})
	if err == nil {
		return blobstore.UploadTarget{}, blobstore.ErrBlobAlreadyExists
	}
	var notFound *s3types.NotFound
	if !errors.As(err, &notFound) {
		return blobstore.UploadTarget{}, err
	}

	req, err := s.presignClient.PresignPostObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucketName),
		Key:    aws.String(blobKey(circleLogID, entryID)),
	}, func(o *s3.PresignPostOptions) {
		o.Expires = uploadURLTTL
		o.Conditions = []any{
			[]any{"content-length-range", 1, s.maxBlobSize},
			map[string]any{"Content-Type": blobContentType},
		}
	})
	if err != nil {
		return blobstore.UploadTarget{}, err
	}
	req.Values["Content-Type"] = blobContentType
	return blobstore.UploadTarget{URL: req.URL, Fields: req.Values}, nil
}

func (s *Store) GetDownloadURL(ctx context.Context, circleLogID, entryID string) (string, error) {
	req, err := s.presignClient.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucketName),
		Key:    aws.String(blobKey(circleLogID, entryID)),
	}, s3.WithPresignExpires(downloadURLTTL))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

// blobKey is the deterministic object key both sides compute independently
// — see server/SYNC_DESIGN.md's "Post" operation: keyed by entryID (known
// to the client before the entry is ever committed), not epoch, so a blob
// can be uploaded before the entry that references it exists. Never a
// separately-issued token.
func blobKey(circleLogID, entryID string) string {
	return fmt.Sprintf("%s/%s", circleLogID, entryID)
}
