module "storage" {
  source                       = "./modules/storage"
  name_prefix                  = local.name_prefix
  blob_glacier_transition_days = var.blob_glacier_transition_days
  invite_retention_days        = var.invite_retention_days
}
