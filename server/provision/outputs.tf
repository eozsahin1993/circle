output "api_endpoint" {
  description = "Base URL the app's src/services/relay.ts should point at."
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "table_name" {
  value = module.storage.table_name
}

output "bucket_name" {
  value = module.storage.bucket_name
}
