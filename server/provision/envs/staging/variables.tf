variable "api_domain" {
  description = "Hostname app builds point at (api.mimoza.app). Empty leaves the raw function URL in place — set it before shipping a build to anyone, since the URL is compiled in."
  type        = string
  default     = ""
}
