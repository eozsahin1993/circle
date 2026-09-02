# Standard KMS envelope encryption for the app's single root secret — see
# server/DESIGN.md's "Email auth" section. This is a first pass only:
# decrypt once via kms:Decrypt at cold start, cache in memory for the
# process lifetime (internal/adapters/kms). Not the attestation-gated
# enclave the design calls out as deferred, later work.
#
# Only ever ONE secret is KMS-encrypted, regardless of how many purposes
# need a key (today just email-HMAC) — every purpose-specific key is
# derived from this one root secret via HKDF (internal/kdf), app-side, not
# provisioned as its own KMS-encrypted secret. See internal/kdf's doc
# comment.
resource "aws_kms_key" "master" {
  description         = "${local.name_prefix} master key — root secret envelope encryption, sessions/accounts tables SSE"
  enable_key_rotation = true
}

resource "random_id" "root_secret" {
  byte_length = 32
}

# Encrypted once, at apply time — the resulting ciphertext blob is safe to
# sit in a plain Lambda env var (ROOT_SECRET_CIPHERTEXT): useless without
# the KMS key that encrypted it.
data "aws_kms_ciphertext" "root_secret" {
  key_id    = aws_kms_key.master.key_id
  plaintext = random_id.root_secret.b64_std
}
