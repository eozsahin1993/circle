# One route, not one per endpoint: the Lambda's own net/http.ServeMux
# (server/internal/api) already does the real routing internally, so API
# Gateway's job is just "forward everything to the one function" — a
# single $default catch-all route rather than three explicit ones.
resource "aws_apigatewayv2_api" "relay" {
  name          = "${local.name_prefix}-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "relay" {
  api_id                 = aws_apigatewayv2_api.relay.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.relay.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.relay.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.relay.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.relay.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.relay.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.relay.execution_arn}/*/*"
}
