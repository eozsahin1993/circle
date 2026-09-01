# Same shape as ../devices_table.tf, against LocalStack. Session rows clean
# themselves up automatically via TTL; device rows have no expiresAt
# attribute, so TTL sweep never touches them.
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

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.master.arn
  }
}
