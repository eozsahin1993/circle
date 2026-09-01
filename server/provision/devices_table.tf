# Standalone table for device/session state — NOT circle-scoped data (no
# circleLogId involved at all), so it doesn't belong in modules/storage or
# share the circle-log table's partition scheme. See server/DESIGN.md's
# "Email auth" section and server/internal/adapters/dynamodb/auth_store.go.
resource "aws_dynamodb_table" "devices" {
  name         = "${local.name_prefix}-devices"
  billing_mode = "PAY_PER_REQUEST"

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

  # Session rows clean themselves up automatically — see
  # auth_store.go's SaveSession. Device rows have no expiresAt attribute at
  # all, so TTL sweep never touches them.
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
