# One Lambda handling every endpoint (its own net/http.ServeMux does the
# real routing internally — see server/internal/api), reachable at a
# single URL — no API Gateway needed. A Function URL is just a dedicated
# HTTPS endpoint attached directly to the function; API Gateway would only
# earn its keep here for multi-function routing, WebSocket, or a custom
# domain, none of which apply yet.
resource "aws_lambda_function_url" "relay" {
  function_name      = aws_lambda_function.relay.function_name
  authorization_type = "NONE"
}

# Function URLs are invoked directly, not via API Gateway, so they need
# their own resource-based permission — distinct action/condition from
# the ordinary "apigateway.amazonaws.com can invoke this" grant.
resource "aws_lambda_permission" "function_url" {
  statement_id           = "AllowFunctionUrlInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.relay.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}
