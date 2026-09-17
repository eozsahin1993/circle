terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # State lives in this env's own account, so the bucket name carries the
  # env — bucket names are globally unique. ../../bootstrap creates it.
  # Backend blocks can't read variables, hence the literal.
  backend "s3" {
    bucket       = "mimoza-terraform-state-prod"
    key          = "prod/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region              = local.aws_region
  profile             = var.aws_profile != "" ? var.aws_profile : null
  allowed_account_ids = var.aws_account_id != "" ? [var.aws_account_id] : null
}

# CloudFront certificates must live in us-east-1 regardless of where the
# relay runs — modules/cdn takes this alias for that one resource.
provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1"
  profile             = var.aws_profile != "" ? var.aws_profile : null
  allowed_account_ids = var.aws_account_id != "" ? [var.aws_account_id] : null
}
