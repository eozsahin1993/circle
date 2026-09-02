# Master key, kept standing by for whatever needs real secret-at-rest
# protection next — planned use: encrypting push notification provider
# credentials (APNs auth key, FCM service account key) once that gets
# built. Not currently used by the app itself: it originally also backed a
# KMS-encrypted "root secret" that internal/crypto derived an email-HMAC
# key from (see server/DESIGN.md's "Email auth" section), but that whole
# path was dead code — real auth ended up keyed on the OIDC `sub` claim
# directly, not email — and got removed along with internal/secrets and
# internal/crypto. Still used for sessions/accounts table SSE (see
# sessions_table.tf/accounts_table.tf) in the meantime.
resource "aws_kms_key" "master" {
  description         = "${local.name_prefix} master key — sessions/accounts tables SSE, reserved for future secret encryption"
  enable_key_rotation = true

  # Everything encrypted under this key — the sessions/accounts tables'
  # SSE today, whatever gets KMS-encrypted here later — is permanently
  # unreadable if it's ever destroyed. This only guards against
  # Terraform-driven destruction (a bad apply/destroy); someone manually
  # scheduling deletion in the AWS console bypasses it entirely — that's
  # an IAM policy concern, not something Terraform can enforce from here.
  lifecycle {
    prevent_destroy = true
  }
}
