terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
      # Billing metrics exist only in us-east-1.
      configuration_aliases = [aws.us_east_1]
    }
  }
}
