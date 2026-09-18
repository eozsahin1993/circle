# One wildcard certificate per environment, shared by every distribution
# in it.
#
# A certificate per hostname would mean a DNS validation record per
# hostname, added by hand, every time a service is added. `*.staging.<zone>`
# is validated once and covers api, cdn and whatever comes next.
#
# CloudFront only accepts certificates from us-east-1, whatever region the
# environment runs in.

resource "aws_acm_certificate" "wildcard" {
  provider          = aws.us_east_1
  domain_name       = "*.${var.domain}"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# Blocks until the record below exists at the DNS provider, so the first
# apply in a new environment stops here: read validation_records, add it,
# re-run. Nothing that needs the certificate can be created until it is
# issued — CloudFront won't attach a pending one.
resource "aws_acm_certificate_validation" "wildcard" {
  provider        = aws.us_east_1
  certificate_arn = aws_acm_certificate.wildcard.arn

  timeouts {
    create = "30m"
  }
}
