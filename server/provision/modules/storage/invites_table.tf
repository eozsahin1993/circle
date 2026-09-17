# Invite/join-request table. Same shape as sync_log (composite pk/sk,
# TTL-evicted). Every row's content is already ciphertext encrypted
# client-side (either with a code-derived key or, for the approval,
# sealed-box-style to a one-time public key). Like every table here it
# relies on DynamoDB's default encryption at rest — no customer-managed
# KMS key anywhere, whose deletion would make its tables unreadable.
resource "aws_dynamodb_table" "invites" {
  name         = "${var.name_prefix}-invites"
  billing_mode = "PAY_PER_REQUEST" # unpredictable, low traffic — no capacity to plan for.

  hash_key  = "pk"
  range_key = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  # Both the invite row and each request row carry their own `expiresAt`
  # (epoch seconds), set at write time from INVITE_RETENTION_DAYS —
  # see internal/invite/dynamodb/invite_store.go. AWS
  # evicts them itself in the background; no application code deletes
  # anything.
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  deletion_protection_enabled = var.deletion_protection
}
