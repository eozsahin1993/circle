output "api_endpoint" {
  description = "Base URL the app's src/services/relay.ts should point at."
  value       = aws_lambda_function_url.relay.function_url
}

output "table_name" {
  value = module.storage.table_name
}

output "bucket_name" {
  value = module.storage.bucket_name
}

output "sessions_table_name" {
  value = aws_dynamodb_table.sessions.name
}

output "accounts_table_name" {
  value = aws_dynamodb_table.accounts.name
}

output "root_secret_ciphertext" {
  value = data.aws_kms_ciphertext.root_secret.ciphertext_blob
}
