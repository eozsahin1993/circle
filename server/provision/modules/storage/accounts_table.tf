# Standalone table for the one document per account (today: the encrypted
# circle-membership manifest — see internal/account/dynamodb).
# One item per
# account, no sort key — there's exactly one document to look up, never a
# second dimension to key on. Genuinely separate from sessions_table.tf
# (different access pattern, no TTL here — kept until the account itself
# is deleted) and from the sync-log table (not circle-scoped data).
resource "aws_dynamodb_table" "accounts" {
  name         = "${var.name_prefix}-accounts"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  deletion_protection_enabled = var.deletion_protection
}
