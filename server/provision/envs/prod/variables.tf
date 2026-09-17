variable "aws_profile" {
  description = "Local AWS profile to apply with. Empty uses the ambient credentials — which is what CI does, assuming its role via OIDC."
  type        = string
  default     = ""
}

variable "aws_account_id" {
  description = "The account this env belongs to. Set it and Terraform refuses to apply anywhere else. Kept out of git: a gitignored *.auto.tfvars locally, a GitHub Environment variable in CI."
  type        = string
  default     = ""
}

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

variable "billing_alert_email" {
  description = "Where the billing alarm mails. Empty leaves the account with no alarm — AWS has no spending cap, so set it."
  type        = string
  default     = ""
}

variable "billing_threshold_usd" {
  description = "Estimated monthly charges that trigger the alarm."
  type        = number
  default     = 20
}
