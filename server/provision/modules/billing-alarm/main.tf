# Estimated charges crossing a threshold, mailed to one address.
#
# Not a cap — AWS has none. This is how you find out about a runaway bill
# in hours instead of on next month's invoice; modules/lambda's
# reserved_concurrency is what actually bounds the spend.
#
# Billing metrics are published only in us-east-1, whatever region the
# stack runs in, so every resource here takes that alias.

resource "aws_sns_topic" "billing" {
  provider = aws.us_east_1
  name     = "${var.name_prefix}-billing-alarm"
}

# Confirm by clicking the link AWS mails when this is first created —
# until then the subscription is pending and the alarm reaches nobody.
resource "aws_sns_topic_subscription" "billing" {
  provider  = aws.us_east_1
  topic_arn = aws_sns_topic.billing.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "billing" {
  provider            = aws.us_east_1
  alarm_name          = "${var.name_prefix}-estimated-charges"
  alarm_description   = "Estimated charges for this account crossed $${var.threshold_usd}."
  namespace           = "AWS/Billing"
  metric_name         = "EstimatedCharges"
  dimensions          = { Currency = "USD" }
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.threshold_usd
  # Billing metrics update a few times a day, so anything shorter than
  # this just evaluates the same value repeatedly.
  period             = 21600
  evaluation_periods = 1
  alarm_actions      = [aws_sns_topic.billing.arn]
}
