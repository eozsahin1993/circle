terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # No remote backend configured yet — state stays local for now. Add an
  # `s3` backend block here once this needs to be shared across machines
  # or you want state locking.
}

provider "aws" {
  region = var.aws_region
}
