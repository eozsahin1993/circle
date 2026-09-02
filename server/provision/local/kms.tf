# Same shape as ../kms.tf, against LocalStack — see main.tf's top comment
# for why local mirrors production's resources one-for-one instead of
# hand-rolling an approximation. No prevent_destroy here deliberately —
# local dev should stay freely recreatable, unlike production.
resource "aws_kms_key" "master" {
  description         = "${local.name_prefix} master key — sessions/accounts tables SSE, reserved for future secret encryption"
  enable_key_rotation = true
}
