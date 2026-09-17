# CloudFront in front of the relay's Lambda function URL, so app builds
# point at a name we own. EXPO_PUBLIC_RELAY_URL is compiled into every
# build (app/src/core/services/relay.ts), so an AWS-generated hostname
# would be permanent — see docs/INFRASTRUCTURE.md.
#
# Caching is off. The relay serves per-user encrypted data, and responses
# depend on the caller's cursor and session. Blobs are the opposite and
# get their own distribution.

locals {
  origin_host = replace(replace(var.origin_url, "https://", ""), "/", "")
  origin_id   = "${var.name_prefix}-relay"
}

# Nothing is cached, and Authorization must reach the relay — the two
# managed policies that say exactly that.
data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

# Forwards every viewer header except Host, which must stay the function
# URL's own: Lambda rejects a Host it doesn't recognize.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_acm_certificate" "relay" {
  provider          = aws.us_east_1
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# Blocks until the CNAME below exists at Cloudflare, so the first apply
# in a new environment stops here: read the domain_validation_records
# output, add the record, re-run. Nothing else can be created until the
# certificate is issued, since CloudFront won't attach a pending one.
resource "aws_acm_certificate_validation" "relay" {
  provider        = aws.us_east_1
  certificate_arn = aws_acm_certificate.relay.arn

  timeouts {
    create = "30m"
  }
}

resource "aws_cloudfront_distribution" "relay" {
  enabled = true
  comment = "${var.name_prefix} relay"
  aliases = [var.domain_name]

  origin {
    origin_id   = local.origin_id
    domain_name = local.origin_host

    custom_origin_config {
      origin_protocol_policy = "https-only"
      http_port              = 80
      https_port             = 443
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = local.origin_id
    viewer_protocol_policy = "redirect-to-https"
    # The relay is a write path too — POST/PUT/DELETE must pass through.
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.relay.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}
