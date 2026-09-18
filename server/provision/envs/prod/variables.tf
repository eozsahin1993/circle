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

variable "reserved_concurrency" {
  description = "Ceiling on concurrent relay executions. -1 leaves it unset, which a new account needs: the default account limit is 10 and AWS refuses to let reservations drop the unreserved pool below 10."
  type        = number
  default     = 50
}

variable "lock_function_url" {
  description = "Require signed origin requests, so only CloudFront can invoke the relay. Clients must send x-amz-content-sha256 with each body's hash first."
  type        = bool
  default     = false
}
