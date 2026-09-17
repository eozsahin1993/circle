output "api_endpoint" {
  description = "Base URL for this env's app builds (EXPO_PUBLIC_RELAY_URL)."
  value       = one(module.cdn[*].api_endpoint) != null ? one(module.cdn[*].api_endpoint) : module.lambda.api_endpoint
}

output "cdn" {
  description = "The CNAME target and certificate validation records to add at Cloudflare. Null until api_domain is set."
  value = one(module.cdn[*]) == null ? null : {
    cname_target       = one(module.cdn[*].distribution_domain_name)
    validation_records = one(module.cdn[*].domain_validation_records)
  }
}

output "resource_prefix" {
  description = "RESOURCE_PREFIX, for running cmd/server against this env."
  value       = local.name_prefix
}
