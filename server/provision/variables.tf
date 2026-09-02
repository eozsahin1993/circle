variable "aws_region" {
  description = "AWS region to deploy the relay into."
  type        = string
  default     = "us-east-1"
}

variable "env" {
  description = "Environment name, folded into every resource's name (e.g. circle-prod-sync-log) so multiple environments can coexist in one account without colliding."
  type        = string
  default     = "prod"
}

locals {
  name_prefix = "circle-${var.env}"
}

variable "log_retention_days" {
  description = "How long a circle's log entries (and their blobs) are kept before AWS evicts them — DynamoDB TTL for the log, an S3 lifecycle rule for blobs — see server/DESIGN.md. Safe to raise anytime; lowering it needs care (see log_store.go's oldestAvailableEpoch doc comment) — start conservative, not aggressive. Exposed here rather than hardcoded so it can be changed without a rebuild."
  type        = number
  default     = 14
}

variable "invite_retention_days" {
  description = "TTL window for invites-table rows (the invite row and each join-request row) — DynamoDB TTL, an expiresAt attribute set at write time — see server/INVITE_FLOW.md and internal/storage/invitestore/dynamodb. Matches the client's INVITE_TTL_MS default of 7 days."
  type        = number
  default     = 7
}

variable "max_blob_size_bytes" {
  description = "Max ciphertext size accepted per blob upload — enforced by S3 itself via a signed content-length-range policy condition, not by the relay. The client's own compression pipeline (app/src/services/image.ts) produces photos well under this default; the cap exists to bound worst-case storage/cost."
  type        = number
  default     = 2097152 # 2 MiB
}

variable "google_client_id_ios" {
  description = "Accepted 'aud' value for Google Sign-In ID tokens from the iOS client registered in Google Cloud Console. Empty string if iOS sign-in isn't in use yet."
  type        = string
  default     = ""
}

variable "google_client_id_android" {
  description = "Accepted 'aud' value for Google Sign-In ID tokens from the Android client registered in Google Cloud Console. Empty string if Android sign-in isn't in use yet."
  type        = string
  default     = ""
}

variable "google_client_id_web" {
  description = "Accepted 'aud' value for Google Sign-In ID tokens from the Web client registered in Google Cloud Console. Empty string if web sign-in isn't in use yet."
  type        = string
  default     = ""
}

variable "apple_client_id_ios" {
  description = "Accepted 'aud' value for Sign in with Apple ID tokens — the app's iOS bundle ID. A Services ID variable would join this if a web/Android Apple flow is ever added."
  type        = string
  default     = ""
}
