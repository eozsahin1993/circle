output "api_endpoint" {
  description = "Base URL for this env's app builds (EXPO_PUBLIC_RELAY_URL). Null until api_domain_name is set."
  value       = local.api_enabled == 0 ? null : "https://${var.api_domain_name}"
}

# The DNS side is manual: records go in at the DNS provider, unproxied —
# proxying would stack two CDNs.
output "dns_records" {
  description = "CNAME targets for this env's hostnames. The certificate's own validation record comes from modules/certificate."
  value = {
    api   = local.api_enabled == 0 ? null : one(aws_cloudfront_distribution.relay[*].domain_name)
    blobs = local.blobs_enabled == 0 ? null : one(aws_cloudfront_distribution.blobs[*].domain_name)
  }
}
