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

variable "blob_glacier_transition_days" {
  description = "Age at which a circle's blobs (photos, avatars, cover images) transition to Glacier Instant Retrieval — see provision/modules/storage/s3.tf and server/SYNC_DESIGN.md. Nothing is ever deleted (the log and its blobs are permanent by design); this only controls when storage gets cheaper. Exposed here rather than hardcoded so it can be changed without a rebuild."
  type        = number
  default     = 90
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

variable "rate_limit_write_max_requests" {
  description = "Per-account write-budget size for the fixed window below (appendlog/rotatelog/createlog/getuploadtarget/getcoverphotouploadtarget) — see internal/storage/ratelimitstore. A starting guess sized to tolerate a large offline-catch-up burst, not a measurement; expected to be retuned from the near-limit warnings the store logs once real traffic exists."
  type        = number
  default     = 500
}

variable "rate_limit_read_max_requests" {
  description = "Per-account read-budget size for the fixed window below (getlog/getblob) — see internal/storage/ratelimitstore. Set much higher than the write budget since ordinary sync reads far more often than it writes."
  type        = number
  default     = 2000
}

variable "rate_limit_window_minutes" {
  description = "Fixed window both rate-limit budgets above reset on."
  type        = number
  default     = 10
}
