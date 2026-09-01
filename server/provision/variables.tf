variable "aws_region" {
  description = "AWS region to deploy the relay into."
  type        = string
  default     = "us-east-1"
}

variable "env" {
  description = "Environment name, folded into every resource's name (e.g. circle-relay-prod-circle-log) so multiple environments can coexist in one account without colliding."
  type        = string
  default     = "prod"
}

locals {
  name_prefix = "circle-relay-${var.env}"
}

variable "log_retention_days" {
  description = "How long a circle's log entries (and their blobs) are kept before AWS evicts them — DynamoDB TTL for the log, an S3 lifecycle rule for blobs — see server/DESIGN.md. Safe to raise anytime; lowering it needs care (see log_store.go's oldestAvailableEpoch doc comment) — start conservative, not aggressive. Exposed here rather than hardcoded so it can be changed without a rebuild."
  type        = number
  default     = 14
}

variable "max_blob_size_bytes" {
  description = "Max ciphertext size accepted per blob upload — enforced by S3 itself via a signed content-length-range policy condition, not by the relay. The client's own compression pipeline (app/src/services/image.ts) produces photos well under this default; the cap exists to bound worst-case storage/cost."
  type        = number
  default     = 2097152 # 2 MiB
}
