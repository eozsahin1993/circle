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
