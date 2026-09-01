output "table_name" {
  description = "Set as TABLE_NAME when running cmd/server against LocalStack."
  value       = module.storage.table_name
}

output "bucket_name" {
  description = "Set as BUCKET_NAME when running cmd/server against LocalStack."
  value       = module.storage.bucket_name
}
