// Package s3 implements blobstore.Store against a single S3 bucket, using
// presigned URLs so ciphertext bytes never pass through Lambda.
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

	// DefaultMaxBlobSize caps a single blob's ciphertext size. The
	// client's own compression pipeline
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

	// Two spellings of one thing: S3 owns the `x-amz-meta-` prefix and
	// strips it on the way back out, so writing and reading differ. Holds
	// the relay account, not the circle identity that authored the post.
	uploaderMetadataKey = "uploader-account-id"
	uploaderField       = "x-amz-meta-" + uploaderMetadataKey
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
// doc for why), then hands off to presignUpload.
func (s *Store) GetUploadTarget(ctx context.Context, syncID, entryID, uploaderAccountID string) (blobstore.UploadTarget, error) {
	key := blobKey(syncID, entryID)
	_, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(s.bucketName), Key: aws.String(key)})
	if err == nil {
		return blobstore.UploadTarget{}, blobstore.ErrBlobAlreadyExists
	}
	var notFound *s3types.NotFound
	if !errors.As(err, &notFound) {
		return blobstore.UploadTarget{}, err
	}
	return s.presignUpload(ctx, key, uploaderAccountID)
}

// coverPhotoEntryID is the fixed "entryID" a circle's cover photo always
// lives at — see GetCoverPhotoUploadTarget. Just a normal blobKey suffix,
// nothing S3-special about it; GetDownloadURL(ctx, syncID, "cover")
// already reads it back with zero changes.
const coverPhotoEntryID = "cover"

// GetCoverPhotoUploadTarget skips GetUploadTarget's existence check —
// see the interface doc for why that's safe here specifically — and
// signs at the fixed key every device will look for a circle's cover
// photo at.
// Records no uploader: a cover is admin-gated on the way in and has no
// delete path.
func (s *Store) GetCoverPhotoUploadTarget(ctx context.Context, syncID string) (blobstore.UploadTarget, error) {
	return s.presignUpload(ctx, blobKey(syncID, coverPhotoEntryID), "")
}

// presignUpload signs a POST policy with a content-length-range condition
// and a pinned Content-Type, so S3 itself rejects an oversized or
// mistyped upload. Unlike Key, ContentType on PutObjectInput isn't picked
// up by PresignPostObject on its own — both need adding explicitly.
// The uploader rides in under a *signed* policy condition, so the client
// must send back exactly the account the relay put there.
func (s *Store) presignUpload(ctx context.Context, key, uploaderAccountID string) (blobstore.UploadTarget, error) {
	conditions := []any{
		[]any{"content-length-range", 1, s.maxBlobSize},
		map[string]any{"Content-Type": blobContentType},
	}
	if uploaderAccountID != "" {
		conditions = append(conditions, map[string]any{uploaderField: uploaderAccountID})
	}

	req, err := s.presignClient.PresignPostObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucketName),
		Key:    aws.String(key),
	}, func(o *s3.PresignPostOptions) {
		o.Expires = uploadURLTTL
		o.Conditions = conditions
	})
	if err != nil {
		return blobstore.UploadTarget{}, err
	}
	req.Values["Content-Type"] = blobContentType
	if uploaderAccountID != "" {
		req.Values[uploaderField] = uploaderAccountID
	}
	return blobstore.UploadTarget{URL: req.URL, Fields: req.Values}, nil
}

// UploaderAccountID reads back what presignUpload recorded.
func (s *Store) UploaderAccountID(ctx context.Context, syncID, entryID string) (string, error) {
	head, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(s.bucketName),
		Key:    aws.String(blobKey(syncID, entryID)),
	})
	if err != nil {
		var notFound *s3types.NotFound
		if errors.As(err, &notFound) {
			return "", blobstore.ErrBlobNotFound
		}
		return "", err
	}
	return head.Metadata[uploaderMetadataKey], nil
}

// DeleteObject reports success whether or not the key was there, which
// is the idempotency the interface promises.
func (s *Store) Delete(ctx context.Context, syncID, entryID string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucketName),
		Key:    aws.String(blobKey(syncID, entryID)),
	})
	return err
}

// DeleteCircle lists and deletes a page at a time rather than collecting
// every key first. The trailing slash matters: without it the prefix
// would also match a circle whose syncID merely starts with this one.
//
// The bucket is unversioned, so these deletes destroy the bytes rather
// than laying down delete markers over recoverable versions — turning
// versioning on would silently stop this deleting anything.
func (s *Store) DeleteCircle(ctx context.Context, syncID string) error {
	paginator := s3.NewListObjectsV2Paginator(s.client, &s3.ListObjectsV2Input{
		Bucket: aws.String(s.bucketName),
		Prefix: aws.String(syncID + "/"),
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return err
		}
		if len(page.Contents) == 0 {
			continue
		}

		objects := make([]s3types.ObjectIdentifier, 0, len(page.Contents))
		for _, object := range page.Contents {
			objects = append(objects, s3types.ObjectIdentifier{Key: object.Key})
		}
		out, err := s.client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(s.bucketName),
			Delete: &s3types.Delete{Objects: objects, Quiet: aws.Bool(true)},
		})
		if err != nil {
			return err
		}
		// DeleteObjects reports per-object failures in the response rather
		// than as an error, so a partial failure would otherwise look like
		// a clean sweep.
		if len(out.Errors) > 0 {
			return fmt.Errorf("deleting blobs for %s: %d of %d objects failed, first: %s", syncID, len(out.Errors), len(objects), aws.ToString(out.Errors[0].Message))
		}
	}
	return nil
}

func (s *Store) GetDownloadURL(ctx context.Context, syncID, entryID string) (string, error) {
	req, err := s.presignClient.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucketName),
		Key:    aws.String(blobKey(syncID, entryID)),
	}, s3.WithPresignExpires(downloadURLTTL))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

// blobKey is the deterministic object key both sides compute independently:
// keyed by entryID (known to the client before the entry is ever
// committed), not epoch, so a blob can be uploaded before the entry that
// references it exists. Never a separately-issued token.
func blobKey(syncID, entryID string) string {
	return fmt.Sprintf("%s/%s", syncID, entryID)
}
