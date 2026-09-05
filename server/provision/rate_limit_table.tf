# Standalone table for per-account rate-limit budgets — one item per
# (keyPrefix, accountId) pair (see server/internal/storage/ratelimitstore/
# dynamodb), no sort key needed since a budget is only ever looked up by
# its composite partition key. No TTL: unlike sessions/invites, rows here
# don't expire — the table's size is bounded by the number of accounts
# times the number of budget categories (write, read), not by time, so
# there's nothing to evict. Genuinely separate from every other table:
# rate limiting is its own access pattern.
resource "aws_dynamodb_table" "rate_limit" {
  name         = "${local.name_prefix}-rate-limit"
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
