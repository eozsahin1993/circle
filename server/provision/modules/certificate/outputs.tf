output "arn" {
  description = "Attach to any distribution serving a hostname under this domain."
  value       = aws_acm_certificate_validation.wildcard.certificate_arn
}

output "validation_records" {
  description = "Add these once per environment; the first apply blocks until they resolve."
  value = [
    for option in aws_acm_certificate.wildcard.domain_validation_options : {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }
  ]
}
