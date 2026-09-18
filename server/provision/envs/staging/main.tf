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

  # Locks the function URL to signed requests once there is a distribution
  # to sign them. Both flip together on the apply that sets api_domain.
  behind_cloudfront    = var.lock_function_url
  reserved_concurrency = var.reserved_concurrency
}

module "cdn" {
  source = "../../modules/cdn"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name_prefix          = local.name_prefix
  origin_url           = module.lambda.api_endpoint
  origin_function_name = module.lambda.function_name

  api_domain_name         = var.api_domain
  sign_origin_requests    = var.lock_function_url
  blob_domain_name        = var.blob_domain
  blob_signing_public_key = var.blob_signing_public_key

  blob_bucket_name                 = module.storage.bucket_name
  blob_bucket_arn                  = module.storage.bucket_arn
  blob_bucket_regional_domain_name = module.storage.bucket_regional_domain_name
}

module "billing_alarm" {
  count  = var.billing_alert_email == "" ? 0 : 1
  source = "../../modules/billing-alarm"

  providers = {
    aws.us_east_1 = aws.us_east_1
  }

  name_prefix   = local.name_prefix
  alert_email   = var.billing_alert_email
  threshold_usd = var.billing_threshold_usd
}
