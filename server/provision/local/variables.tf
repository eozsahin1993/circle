variable "env" {
  description = "Environment name, folded into every resource's name — matches the pattern in ../variables.tf. Defaults to \"local\" so output/log messages are never ambiguous about which environment they refer to, though there's no actual collision risk either way since this applies to LocalStack, not a shared AWS account."
  type        = string
  default     = "local"
}

locals {
  name_prefix = "circle-${var.env}"
}
