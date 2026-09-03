variable "name_prefix" {
  description = "Prefix applied to every named resource, so multiple environments (dev/prod/local) can coexist without colliding."
  type        = string
}

variable "blob_glacier_transition_days" {
  description = "Age at which S3 transitions a blob to Glacier Instant Retrieval (see s3.tf) — blobs are never deleted, only tiered. Defaults to Glacier IR's own 90-day minimum billable duration."
  type        = number
  default     = 90
}

variable "invite_retention_days" {
  description = "TTL window for invites-table rows (both the invite row and each join-request row) — see server/INVITE_FLOW.md and internal/storage/invitestore/dynamodb."
  type        = number
  default     = 7
}
