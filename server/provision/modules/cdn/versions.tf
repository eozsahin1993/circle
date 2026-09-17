terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
      # CloudFront only accepts certificates from us-east-1, whatever
      # region the relay itself runs in.
      configuration_aliases = [aws.us_east_1]
    }
  }
}
