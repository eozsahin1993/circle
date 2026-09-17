output "api_endpoint" {
  description = "Base URL for this env's app builds (EXPO_PUBLIC_RELAY_URL)."
  value       = "https://${var.domain_name}"
}

output "distribution_domain_name" {
  description = "What the domain's CNAME points at, at Cloudflare. Grey cloud (DNS only) — proxying would stack two CDNs."
  value       = aws_cloudfront_distribution.relay.domain_name
}

output "domain_validation_records" {
  description = "Add these at Cloudflare to issue the certificate; the first apply waits on them."
  value = [
    for option in aws_acm_certificate.relay.domain_validation_options : {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }
  ]
}
