# Same shape as ../kms.tf, against LocalStack — see main.tf's top comment
# for why local mirrors production's resources one-for-one instead of
# hand-rolling an approximation.
resource "aws_kms_key" "master" {
  description         = "${local.name_prefix} master key — root secret envelope encryption, sessions/accounts tables SSE"
  enable_key_rotation = true
}

resource "random_id" "root_secret" {
  byte_length = 32
}

data "aws_kms_ciphertext" "root_secret" {
  key_id    = aws_kms_key.master.key_id
  plaintext = random_id.root_secret.b64_std
}
