# Single-table design, one partition per syncId — see log_store.go for
# the key-shape rationale.
resource "aws_dynamodb_table" "sync_log" {
  name         = "${var.name_prefix}-sync-log"
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

  attribute {
    name = "entryId"
    type = "S"
  }

  # Lets DeletePost find a post by entryId without knowing its epoch.
  # KEYS_ONLY — callers fetch the full row from the base table after.
  # Not a substitute for the idempotency marker below: GSIs are
  # eventually consistent, so this can't do the marker's atomic
  # already-exists check.
  global_secondary_index {
    name            = "entryId-index"
    hash_key        = "entryId"
    projection_type = "KEYS_ONLY"
  }

  # Only idempotency markers ever carry an `expiresAt` — a short, fixed
  # retry window (log_store.go's idemMarkerTTL), not a product setting.
  # Log entries and #control never set it: the log is permanent (invariant
  # 1). AWS sweeps expired items itself; no application code deletes.
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  deletion_protection_enabled = var.deletion_protection
}

# Invite/join-request table. Same shape as sync_log above (composite
# pk/sk, TTL-evicted). Every row's content is already ciphertext encrypted
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
