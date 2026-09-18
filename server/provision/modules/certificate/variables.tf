variable "domain" {
  description = "The environment's own zone — staging.example.com, or example.com for production. Every hostname in the env lives under it."
  type        = string
}
