variable "name_prefix" {
  description = "Prefix applied to every named resource (mimoza-<env>)."
  type        = string
}

variable "repository" {
  description = "owner/repo allowed to assume the role. Anything else presenting a GitHub token is refused."
  type        = string
}

variable "environment" {
  description = "The GitHub Environment a workflow must declare to assume this role — the gate that carries the approval rules."
  type        = string
}
