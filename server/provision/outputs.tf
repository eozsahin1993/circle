output "api_endpoint" {
  description = "Base URL the app's src/services/relay.ts should point at."
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "table_name" {
  value = aws_dynamodb_table.circle_log.name
}

output "bucket_name" {
  value = aws_s3_bucket.circle_blobs.id
}
