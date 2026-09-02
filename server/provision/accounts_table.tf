# Standalone table for the one document per account (today: the encrypted
# circle-membership manifest — see server/DESIGN.md's "Account recovery"
# section and internal/storage/manifeststore/dynamodb). One item per
# account, no sort key — there's exactly one document to look up, never a
# second dimension to key on. Genuinely separate from sessions_table.tf
# (different access pattern, no TTL here — kept until the account itself
# is deleted) and from the sync-log table (not circle-scoped data).
resource "aws_dynamodb_table" "accounts" {
  name         = "${local.name_prefix}-accounts"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.master.arn
  }

  # Deletable for now, pre-production — set prevent_destroy = true once
  # this table holds real user data.
  lifecycle {
    prevent_destroy = false
  }
}
