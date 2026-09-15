# Standalone table for bearer-token sessions — one item per token, no sort
# key (a session is only ever looked up by the token itself). Genuinely
# separate from accounts_table.tf: token-lookup vs account-lookup are
# different access patterns, and sessions are ephemeral (TTL'd) where the
# account document isn't. See internal/auth/dynamodb.
resource "aws_dynamodb_table" "sessions" {
  name         = "${local.name_prefix}-sessions"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "accountId"
    type = "S"
  }

  # Lets account deletion revoke every session for an account, not just
  # the one that made the call — sessions are otherwise only ever looked
  # up by token. KEYS_ONLY: DeleteAllSessions only needs the pk (token)
  # back to delete each item.
  global_secondary_index {
    name            = "accountId-index"
    hash_key        = "accountId"
    projection_type = "KEYS_ONLY"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
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
