# Single-table design — see server/internal/adapters/dynamodb/keys.go for
# the key-shape rationale (why sort key is a string, not a number).
resource "aws_dynamodb_table" "circle_log" {
  name         = "${var.name_prefix}-circle-log"
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

  # Deletable for now, pre-production — set prevent_destroy = true once
  # this table holds real user data.
  lifecycle {
    prevent_destroy = false
  }
}
