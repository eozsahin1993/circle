output "api_endpoint" {
  description = "The relay's base URL — what a build's EXPO_PUBLIC_RELAY_URL points at."
  value       = aws_lambda_function_url.relay.function_url
}
