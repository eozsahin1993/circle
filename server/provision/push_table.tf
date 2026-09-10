# Standalone table for push routing state — see server/PUSH_DESIGN.md.
# PK = routingId, SK distinguishes the prefs row ("prefs") from each
# device's row ("device#<deviceId>"), same single-table shape as the
# invites and log tables.
#
# No TTL, unlike sessions and invites: a routing id is durable state, how a
# device stays reachable between posts, not a handoff that expires. Rows go
# away when a device unregisters or a circle is silenced, never on a timer.
#
# What this table deliberately does not hold: account ids, circle ids, sync
# ids, and any list of which routing ids belong together. Someone reading
# it should find opaque ids, encrypted push tokens, salted hashes and
# category bits — nothing that groups people. The fanout hash is salted per
# row precisely so a circle's rows don't share an identical value that
# would cluster its membership straight out of a table scan.
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

  # Deletable for now, pre-production — set prevent_destroy = true once
  # this table holds real device tokens.
  lifecycle {
    prevent_destroy = false
  }
}
