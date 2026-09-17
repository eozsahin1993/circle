locals {
  env         = "staging"
  aws_region  = "us-east-1"
  name_prefix = "mimoza-${local.env}"
}

module "storage" {
  source      = "../../modules/storage"
  name_prefix = local.name_prefix

  deletion_protection = false
}

module "lambda" {
  source      = "../../modules/lambda"
  name_prefix = local.name_prefix
  aws_region  = local.aws_region
  binary_path = "${path.root}/../../build/bootstrap"
  storage     = module.storage
}

module "cdn" {
  count  = var.api_domain == "" ? 0 : 1
  source = "../../modules/cdn"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name_prefix = local.name_prefix
  domain_name = var.api_domain
  origin_url  = module.lambda.api_endpoint
}
