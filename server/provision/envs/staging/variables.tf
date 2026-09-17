variable "api_domain" {
  description = "Hostname app builds point at (api.mimoza.app). Empty leaves the raw function URL in place — set it before shipping a build to anyone, since the URL is compiled in."
  type        = string
  default     = ""
}

variable "blob_domain" {
  description = "Hostname photo downloads are served from (cdn.mimoza.app). Empty leaves reads on presigned S3 URLs."
  type        = string
  default     = ""
}

variable "blob_signing_public_key" {
  description = "PEM public key for signing blob download URLs; its private half goes in SSM by hand. Required with blob_domain."
  type        = string
  default     = ""
}
