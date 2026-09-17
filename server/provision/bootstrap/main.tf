# The bucket this account's env keeps state in (see envs/*/versions.tf).
# Applied once per AWS account, before any env: its own state is local and
# gitignored, since it can't live in the bucket it creates. Losing that
# state is harmless — `terraform import aws_s3_bucket.state <name>`
# recovers it.
#
# The name carries the env because bucket names are globally unique and
# each env is its own account: two accounts cannot both hold
# "mimoza-terraform-state".
terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region              = "us-east-1"
  profile             = var.aws_profile != "" ? var.aws_profile : null
  allowed_account_ids = var.aws_account_id != "" ? [var.aws_account_id] : null
}

variable "aws_profile" {
  description = "Local AWS profile to apply with. Empty uses the ambient credentials."
  type        = string
  default     = ""
}

variable "aws_account_id" {
  description = "The account this bucket belongs in. Set it and Terraform refuses to apply anywhere else — this runs before any env, against whatever profile is ambient, so the guard matters most here."
  type        = string
  default     = ""
}

variable "bucket_name" {
  description = "State bucket for this account — mimoza-terraform-state-<env>. Must match the env's backend block, which can't read variables."
  type        = string
}

resource "aws_s3_bucket" "state" {
  bucket = var.bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

# Every apply writes a new version, so a bad apply or a corrupted state
# file can be rolled back.
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
