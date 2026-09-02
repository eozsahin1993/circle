# Single-table design — see server/internal/adapters/dynamodb/keys.go for
# the key-shape rationale (why sort key is a string, not a number).
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

  # Log entries and idempotency markers each carry their own `expiresAt`
  # (epoch seconds), set at write time from log_retention_days — see
  # internal/adapters/dynamodb/log_store.go's CommitEntry. AWS evicts them
  # itself in the background; no application code deletes anything.
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  # Deletable for now, pre-production — set prevent_destroy = true once
  # this table holds real user data.
  lifecycle {
    prevent_destroy = false
  }
}
