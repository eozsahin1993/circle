# Same shape as ../push_table.tf, against LocalStack.
resource "aws_dynamodb_table" "push" {
  name         = "${local.name_prefix}-push"
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

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.master.arn
  }
}
