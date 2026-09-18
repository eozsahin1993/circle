variable "name_prefix" {
  description = "Prefix applied to every named resource (mimoza-<env>)."
  type        = string
}

variable "api_domain_name" {
  description = "The hostname app builds point at (api.mimoza.app). Empty leaves the raw function URL in place."
  type        = string
  default     = ""
}

variable "origin_url" {
  description = "The Lambda function URL to forward to — the module takes the host out of it."
  type        = string
}

variable "origin_function_name" {
  description = "The relay Lambda's name, for the invoke permission scoped to this distribution."
  type        = string
}

variable "sign_origin_requests" {
  description = "Lock the function URL to this distribution (origin access control). Requires the client to send x-amz-content-sha256 on every request with a body — Lambda rejects unsigned payloads."
  type        = bool
  default     = false
}

variable "certificate_arn" {
  description = "The environment's wildcard certificate — one per env, covering every hostname in it (modules/certificate)."
  type        = string
  default     = ""
}

variable "blob_domain_name" {
  description = "The hostname photo downloads are served from (cdn.mimoza.app). Empty leaves reads on presigned S3 URLs."
  type        = string
  default     = ""
}

variable "blob_signing_public_key" {
  description = "PEM public key whose private half the relay signs download URLs with, held in SSM by hand. Required with blob_domain_name."
  type        = string
  default     = ""
}

variable "blob_bucket_name" {
  description = "The blob bucket, for the policy that lets only this distribution read it."
  type        = string
}

variable "blob_bucket_arn" {
  description = "The blob bucket's ARN."
  type        = string
}

variable "blob_bucket_regional_domain_name" {
  description = "The blob bucket's regional endpoint, used as the distribution's origin."
  type        = string
}
