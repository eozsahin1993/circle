output "api_endpoint" {
  description = "Base URL for this env's app builds (EXPO_PUBLIC_RELAY_URL)."
  value       = module.lambda.api_endpoint
}

output "resource_prefix" {
  description = "RESOURCE_PREFIX, for running cmd/server against this env."
  value       = local.name_prefix
}
