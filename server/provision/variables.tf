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

variable "ring_buffer_size" {
  description = "Max log entries retained per circle before the oldest get trimmed — see server/DESIGN.md. A single tunable constant, not expected to need per-environment overrides, but exposed here rather than hardcoded in Go so it can be changed without a rebuild."
  type        = number
  default     = 2000
}

variable "max_blob_size_bytes" {
  description = "Max ciphertext size accepted per blob upload — enforced by S3 itself via a signed content-length-range policy condition, not by the relay. The client's own compression pipeline (app/src/services/image.ts) produces photos well under this default; the cap exists to bound worst-case storage/cost."
  type        = number
  default     = 2097152 # 2 MiB
}
