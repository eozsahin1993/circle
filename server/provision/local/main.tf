# Provisions the exact same table/bucket shape as production (see
# ../modules/storage), plus the auth stack (kms.tf, sessions_table.tf,
# accounts_table.tf — mirroring ../kms.tf, ../sessions_table.tf, and
# ../accounts_table.tf), against LocalStack instead
# of real AWS — so manually running cmd/server locally and pointing it at
# these resources behaves like the real deployment, not like a hand-rolled
# approximation of it. Lambda and API Gateway are deliberately not part of
# this: local manual testing runs cmd/server directly (see ../../cmd/server),
# which never touches either.
module "storage" {
  source      = "../modules/storage"
  name_prefix = local.name_prefix
}
