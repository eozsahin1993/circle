variable "name_prefix" {
  description = "Prefix applied to every named resource (mimoza-<env>), so environments sharing an account never collide."
  type        = string
}

variable "deletion_protection" {
  description = "Blocks deleting any table, and a non-empty blob bucket, through Terraform or the console. Off for local and pre-launch environments so they stay freely recreatable."
  type        = bool
  default     = false
}

variable "blob_glacier_transition_days" {
  description = "Age at which S3 transitions a blob to Glacier Instant Retrieval (see s3.tf) — nothing expires on a timer, it is only tiered — a blob goes when its post is deleted (see internal/synclog/http/deleteblob). Defaults to Glacier IR's own 90-day minimum billable duration."
  type        = number
  default     = 90
}
