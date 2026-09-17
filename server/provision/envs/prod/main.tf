locals {
  env         = "prod"
  aws_region  = "us-east-1"
  name_prefix = "mimoza-${local.env}"
}

module "storage" {
  source      = "../../modules/storage"
  name_prefix = local.name_prefix

  # Off until launch; turn on before real user data lands here.
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
  source = "../../modules/cdn"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name_prefix = local.name_prefix
  origin_url  = module.lambda.api_endpoint

  api_domain_name         = var.api_domain
  blob_domain_name        = var.blob_domain
  blob_signing_public_key = var.blob_signing_public_key

  blob_bucket_name                 = module.storage.bucket_name
  blob_bucket_arn                  = module.storage.bucket_arn
  blob_bucket_regional_domain_name = module.storage.bucket_regional_domain_name
}
