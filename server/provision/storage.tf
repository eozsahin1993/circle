module "storage" {
  source             = "./modules/storage"
  name_prefix        = local.name_prefix
  log_retention_days = var.log_retention_days
}
