output "api_endpoint" {
  description = "The relay's base URL — what a build's EXPO_PUBLIC_RELAY_URL points at."
  value       = aws_lambda_function_url.relay.function_url
}

output "function_name" {
  description = "For the CloudFront-side invoke permission — see modules/cdn."
  value       = aws_lambda_function.relay.function_name
}
