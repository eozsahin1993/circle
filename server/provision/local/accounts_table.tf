# Same shape as ../accounts_table.tf, against LocalStack.
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
}
