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

output "invite_table_name" {
  value = module.storage.invite_table_name
}

output "rate_limit_table_name" {
  value = aws_dynamodb_table.rate_limit.name
}
