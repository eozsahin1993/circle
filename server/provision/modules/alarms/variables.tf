variable "name_prefix" {
  description = "Prefix applied to every named resource (mimoza-<env>)."
  type        = string
}

variable "alert_email" {
  description = "Where alarms mail. Empty creates none of them."
  type        = string
  default     = ""
}

variable "aws_region" {
  description = "The region the relay runs in. Alarms must live beside the metric they watch, and beside the topic they notify — which is why billing (us-east-1 only) may need a topic of its own."
  type        = string
}

variable "function_name" {
  description = "The relay Lambda to watch."
  type        = string
}

variable "table_names" {
  description = "DynamoDB tables to watch for throttles."
  type        = list(string)
  default     = []
}

variable "billing_threshold_usd" {
  description = "Estimated monthly charges that trigger the billing alarm. Set near expected spend, not near what you can afford."
  type        = number
  default     = 20
}

variable "lambda_timeout_seconds" {
  description = "The function's own timeout, so the duration alarm can fire before requests start failing rather than after."
  type        = number
  default     = 10
}
