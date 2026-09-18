# Standalone table for the per-account documents: the encrypted
# circle-membership manifest (internal/account/dynamodb), keyed on the
# bare account id, and the Apple refresh token account deletion revokes
# with (internal/auth/dynamodb), keyed under its own "apple-refresh#"
# prefix. No sort key — each kind is a single document looked up by a
# known key, never a second dimension to range over.
# Genuinely separate from sessions_table.tf
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
