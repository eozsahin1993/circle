output "table_name" {
  description = "Set as TABLE_NAME when running cmd/server against LocalStack."
  value       = module.storage.table_name
}

output "bucket_name" {
  description = "Set as BUCKET_NAME when running cmd/server against LocalStack."
  value       = module.storage.bucket_name
}

output "devices_table_name" {
  description = "Set as DEVICES_TABLE_NAME when running cmd/server against LocalStack."
  value       = aws_dynamodb_table.devices.name
}

output "root_secret_ciphertext" {
  description = "Set as ROOT_SECRET_CIPHERTEXT when running cmd/server against LocalStack."
  value       = data.aws_kms_ciphertext.root_secret.ciphertext_blob
}
