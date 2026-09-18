# CloudFront in front of the relay's Lambda function URL, so app builds
# point at a name we own. EXPO_PUBLIC_RELAY_URL is compiled into every
# build (app/src/core/services/relay.ts), so an AWS-generated hostname
# would be permanent — see docs/INFRASTRUCTURE.md.
#
# Caching is off here. The relay serves per-user encrypted data, and
# responses depend on the caller's cursor and session. Blobs are the
# opposite — see blobs.tf.

locals {
  api_enabled = var.api_domain_name == "" ? 0 : 1
  # Both exist whenever the distribution does — they are free, and
  # deleting them needs the distribution to release them first, which
  # Terraform can't see once the reference is gone.
  #
  # Signing the origin request is a contract with the client, not just an
  # infrastructure setting: Lambda rejects unsigned payloads, so every
  # POST/PUT must carry x-amz-content-sha256 with the body's hash. Off
  # until the client sends it — see docs/INFRASTRUCTURE.md.
  oac_enabled = var.api_domain_name != "" && var.sign_origin_requests ? 1 : 0
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

# Signs every request to the origin, so the function URL can refuse
# anything that didn't come through this distribution.
resource "aws_cloudfront_origin_access_control" "relay" {
  count                             = local.api_enabled
  name                              = "${var.name_prefix}-relay"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# The counterpart to modules/lambda's public permission, scoped to this
# distribution. Granted here because the ARN lives here — the lambda
# module can't reference it without a cycle.
resource "aws_lambda_permission" "cloudfront" {
  count                  = local.oac_enabled
  statement_id           = "AllowCloudFrontInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = var.origin_function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.relay[0].arn
  function_url_auth_type = "AWS_IAM"
}

# Same pairing the public grant needs: a function URL checks both actions,
# and granting only InvokeFunctionUrl returns 403 AccessDeniedException
# before the function runs. FunctionUrlAuthType can't be set on this one —
# Lambda only accepts that condition for InvokeFunctionUrl.
resource "aws_lambda_permission" "cloudfront_invoke" {
  count         = local.oac_enabled
  statement_id  = "AllowCloudFrontInvokeFunction"
  action        = "lambda:InvokeFunction"
  function_name = var.origin_function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.relay[0].arn
}

resource "aws_acm_certificate" "relay" {
  count             = local.api_enabled
  provider          = aws.us_east_1
  domain_name       = var.api_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# Blocks until the CNAME below exists at Cloudflare, so the first apply in
# a new environment stops here: read the validation records output, add
# them, re-run. Nothing else can be created until the certificate is
# issued, since CloudFront won't attach a pending one.
resource "aws_acm_certificate_validation" "relay" {
  count           = local.api_enabled
  provider        = aws.us_east_1
  certificate_arn = aws_acm_certificate.relay[0].arn

  timeouts {
    create = "30m"
  }
}

# CloudFront signs the headers it sends to a Lambda function URL but not
# the body, so every request carrying one fails with
# InvalidSignatureException — which is most of this API. Declaring the
# payload unsigned is what makes sigv4 accept it.
#
# The signature is here to prove the request came from this distribution,
# not to protect the body: entries are signed by their author's key and
# encrypted client-side long before the relay sees them.
resource "aws_cloudfront_function" "unsigned_payload" {
  count   = local.api_enabled
  name    = "${var.name_prefix}-unsigned-payload"
  runtime = "cloudfront-js-2.0"
  publish = true
  comment = "Marks the payload unsigned so POST/PUT survive OAC signing"
  code    = <<-JS
    function handler(event) {
      event.request.headers['x-amz-content-sha256'] = { value: 'UNSIGNED-PAYLOAD' };
      return event.request;
    }
  JS
}

resource "aws_cloudfront_distribution" "relay" {
  count   = local.api_enabled
  enabled = true
  comment = "${var.name_prefix} relay"
  aliases = [var.api_domain_name]

  origin {
    origin_id                = local.origin_id
    domain_name              = local.origin_host
    origin_access_control_id = local.oac_enabled == 1 ? one(aws_cloudfront_origin_access_control.relay[*].id) : null

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

    dynamic "function_association" {
      for_each = local.oac_enabled == 1 ? aws_cloudfront_function.unsigned_payload : []
      content {
        event_type   = "viewer-request"
        function_arn = function_association.value.arn
      }
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.relay[0].certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}
