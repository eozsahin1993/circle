# Holds only encrypted ciphertext (see server/DESIGN.md's encryption
# envelope) — the relay itself can never read what's in here. Stays
# private regardless: access is entirely gated by short-lived presigned
# URLs, never by bucket policy or public access.
resource "aws_s3_bucket" "circle_blobs" {
  bucket = "${var.name_prefix}-circle-blobs"
}

resource "aws_s3_bucket_public_access_block" "circle_blobs" {
  bucket = aws_s3_bucket.circle_blobs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Presigned PUT/GET need CORS to work from a browser context (e.g. Expo
# web) — native mobile HTTP clients don't enforce CORS, but this covers
# both without needing to know which client is uploading. The bucket only
# ever holds ciphertext, so a permissive origin list doesn't expose
# anything a same-origin policy would have protected.
resource "aws_s3_bucket_cors_configuration" "circle_blobs" {
  bucket = aws_s3_bucket.circle_blobs.id

  cors_rule {
    allowed_methods = ["GET", "PUT"]
    allowed_origins = ["*"]
    allowed_headers = ["*"]
    max_age_seconds = 3000
  }
}

# Same retention window as the DynamoDB log's TTL (see dynamodb.tf) — a
# blob shouldn't outlive the log entry that points to it, and this is the
# dominant cost driver (photos, not log metadata), so it's the one that
# actually matters for keeping storage bounded rather than growing forever.
resource "aws_s3_bucket_lifecycle_configuration" "circle_blobs" {
  bucket = aws_s3_bucket.circle_blobs.id

  rule {
    id     = "expire-blobs"
    status = "Enabled"

    filter {}

    expiration {
      days = var.log_retention_days
    }
  }
}
