output "table_name" {
  description = "Set as TABLE_NAME when running cmd/server against LocalStack."
  value       = module.storage.table_name
}

output "bucket_name" {
  description = "Set as BUCKET_NAME when running cmd/server against LocalStack."
  value       = module.storage.bucket_name
}

output "sessions_table_name" {
  description = "Set as SESSIONS_TABLE_NAME when running cmd/server against LocalStack."
  value       = aws_dynamodb_table.sessions.name
}

output "accounts_table_name" {
  description = "Set as ACCOUNTS_TABLE_NAME when running cmd/server against LocalStack."
  value       = aws_dynamodb_table.accounts.name
}

output "root_secret_ciphertext" {
  description = "Set as ROOT_SECRET_CIPHERTEXT when running cmd/server against LocalStack."
  value       = data.aws_kms_ciphertext.root_secret.ciphertext_blob
}
