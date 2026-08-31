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
)

type BlobStore struct {
	presignClient *s3.PresignClient
	bucketName    string
}

func NewBlobStore(client *s3.Client, bucketName string) *BlobStore {
	return &BlobStore{presignClient: s3.NewPresignClient(client), bucketName: bucketName}
}

var _ ports.BlobStore = (*BlobStore)(nil)

func (b *BlobStore) GetUploadURL(ctx context.Context, circleLogID string, epoch int64) (string, error) {
	req, err := b.presignClient.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(b.bucketName),
		Key:    aws.String(blobKey(circleLogID, epoch)),
	}, s3.WithPresignExpires(uploadURLTTL))
	if err != nil {
		return "", err
	}
	return req.URL, nil
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
