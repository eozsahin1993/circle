variable "name_prefix" {
  description = "Prefix applied to every named resource (mimoza-<env>)."
  type        = string
}

variable "alert_email" {
  description = "Where the alarm mails. Empty disables the alarm entirely."
  type        = string
  default     = ""
}

variable "threshold_usd" {
  description = "Estimated monthly charges that trigger the alarm. Set near expected spend, not near what you can afford."
  type        = number
  default     = 20
}
