variable "aws_region" {
  description = "AWS region to deploy the relay into."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix applied to every named resource, so multiple environments (dev/prod) can coexist in one account without colliding."
  type        = string
  default     = "circle-relay"
}

variable "ring_buffer_size" {
  description = "Max log entries retained per circle before the oldest get trimmed — see server/DESIGN.md. A single tunable constant, not expected to need per-environment overrides, but exposed here rather than hardcoded in Go so it can be changed without a rebuild."
  type        = number
  default     = 2000
}
