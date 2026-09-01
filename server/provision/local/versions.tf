terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# Same provider, pointed at LocalStack instead of real AWS — the point of
# this root config is that modules/storage itself never needs to know the
# difference. Credentials are dummy values LocalStack ignores; the
# skip_* flags disable checks that assume a real AWS account exists.
provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true # LocalStack doesn't resolve virtual-hosted-style bucket subdomains.

  endpoints {
    dynamodb = "http://localhost:4566"
    s3       = "http://localhost:4566"
    kms      = "http://localhost:4566"
  }
}
