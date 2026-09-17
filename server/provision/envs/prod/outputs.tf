output "api_endpoint" {
  description = "Base URL for this env's app builds (EXPO_PUBLIC_RELAY_URL)."
  value       = coalesce(module.cdn.api_endpoint, module.lambda.api_endpoint)
}

output "blob_base_url" {
  description = "Where the relay signs blob download URLs against. Null while reads still use presigned S3 URLs."
  value       = module.cdn.blob_base_url
}

output "blob_key_pair_id" {
  description = "Key-Pair-Id for signed blob URLs — pairs with the private key in SSM."
  value       = module.cdn.blob_key_pair_id
}

output "dns_records" {
  description = "CNAME targets and certificate validation records to add at Cloudflare, grey cloud."
  value       = module.cdn.dns_records
}

output "resource_prefix" {
  description = "RESOURCE_PREFIX, for running cmd/server against this env."
  value       = local.name_prefix
}
