variable "name_prefix" {
  description = "Prefix applied to every named resource, so multiple environments (dev/prod/local) can coexist without colliding."
  type        = string
}

variable "log_retention_days" {
  description = "Age at which S3 expires a blob — kept in step with the DynamoDB TTL on the log entry that points to it (see log_store.go), so a blob doesn't outlive the entry referencing it."
  type        = number
  default     = 14
}

variable "invite_retention_days" {
  description = "TTL window for invites-table rows (both the invite row and each join-request row) — see server/INVITE_FLOW.md and internal/storage/invitestore/dynamodb."
  type        = number
  default     = 7
}
