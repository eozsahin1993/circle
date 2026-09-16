# The same storage module as staging and prod, against LocalStack — so
# running cmd/server locally behaves like the real deployment, not like a
# hand-rolled approximation of it. No Lambda: local runs cmd/server
# directly (see ../../../cmd/server).
locals {
  name_prefix = "mimoza-local"
}

module "storage" {
  source      = "../../modules/storage"
  name_prefix = local.name_prefix
}
