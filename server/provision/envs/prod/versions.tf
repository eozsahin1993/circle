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

  # One state file per env in the bucket ../../bootstrap creates. Backend
  # blocks can't read variables, so the bucket name is repeated literally
  # in every env's versions.tf.
  backend "s3" {
    bucket       = "mimoza-terraform-state"
    key          = "prod/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = local.aws_region
}
