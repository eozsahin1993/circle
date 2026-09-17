variable "name_prefix" {
  description = "Prefix applied to every named resource (mimoza-<env>)."
  type        = string
}

variable "domain_name" {
  description = "The hostname app builds point at (api.mimoza.app). DNS lives at Cloudflare; see outputs."
  type        = string
}

variable "origin_url" {
  description = "The Lambda function URL to forward to — the module takes the host out of it."
  type        = string
}
