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

# Blobs are never deleted — permanent retention, same as the log entries
# that point to them (server/SYNC_DESIGN.md invariant 1). Affordable via
# tiering, not eviction: after blob_glacier_transition_days, objects move
# to Glacier Instant Retrieval — same millisecond-latency access as
# Standard, ~6x cheaper per GB. Defaults to Glacier IR's own 90-day
# minimum billable duration.
resource "aws_s3_bucket_lifecycle_configuration" "circle_blobs" {
  bucket = aws_s3_bucket.circle_blobs.id

  rule {
    id     = "archive-blobs"
    status = "Enabled"

    filter {}

    transition {
      days          = var.blob_glacier_transition_days
      storage_class = "GLACIER_IR"
    }
  }
}
