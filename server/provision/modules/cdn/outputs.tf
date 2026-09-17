output "api_endpoint" {
  description = "Base URL for this env's app builds (EXPO_PUBLIC_RELAY_URL). Null until api_domain_name is set."
  value       = local.api_enabled == 0 ? null : "https://${var.api_domain_name}"
}

output "blob_base_url" {
  description = "Where the relay signs download URLs against. Null until blob_domain_name is set."
  value       = local.blobs_enabled == 0 ? null : "https://${var.blob_domain_name}"
}

output "blob_key_pair_id" {
  description = "Key-Pair-Id the relay puts in signed URLs — pairs with the private key in SSM."
  value       = one(aws_cloudfront_public_key.blobs[*].id)
}

# The DNS side is manual: records go in at Cloudflare, grey cloud (DNS
# only). Proxying would stack two CDNs.
output "dns_records" {
  description = "CNAME targets and certificate validation records to add at Cloudflare. The first apply blocks on validation."
  value = {
    api = local.api_enabled == 0 ? null : {
      cname_target = one(aws_cloudfront_distribution.relay[*].domain_name)
      validation = [
        for option in aws_acm_certificate.relay[0].domain_validation_options : {
          name  = option.resource_record_name
          type  = option.resource_record_type
          value = option.resource_record_value
        }
      ]
    }
    blobs = local.blobs_enabled == 0 ? null : {
      cname_target = one(aws_cloudfront_distribution.blobs[*].domain_name)
      validation = [
        for option in aws_acm_certificate.blobs[0].domain_validation_options : {
          name  = option.resource_record_name
          type  = option.resource_record_type
          value = option.resource_record_value
        }
      ]
    }
  }
}
