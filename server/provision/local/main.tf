# Provisions the exact same table/bucket shape as production (see
# ../modules/storage), against LocalStack instead of real AWS — so
# manually running cmd/server locally and pointing it at these resources
# behaves like the real deployment, not like a hand-rolled approximation
# of it. Lambda and API Gateway are deliberately not part of this: local
# manual testing runs cmd/server directly (see ../../cmd/server), which
# never touches either.
module "storage" {
  source      = "../modules/storage"
  name_prefix = local.name_prefix
}
