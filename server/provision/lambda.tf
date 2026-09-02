# The pre-built Go binary — see build.sh. Terraform doesn't invoke `go
# build` itself (kept as a separate, explicit step rather than a
# provisioner): run ./build.sh before `terraform apply`/`terraform plan`
# whenever the Go source changes.
data "archive_file" "lambda" {
  type        = "zip"
  source_file = "${path.module}/build/bootstrap"
  output_path = "${path.module}/build/lambda.zip"
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.name_prefix}-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Scoped to exactly the one table and one bucket this relay owns — no
# wildcard resource ARNs.
data "aws_iam_policy_document" "lambda_storage_access" {
  statement {
    sid = "DynamoDBAccess"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
      "dynamodb:TransactWriteItems",
    ]
    resources = [module.storage.table_arn]
  }

  statement {
    sid = "S3Access"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
    ]
    resources = ["${module.storage.bucket_arn}/*"]
  }

  # Separate statement, separate resource list from DynamoDBAccess above —
  # sessions is a genuinely different table, not the sync-log one (see
  # sessions_table.tf). Matches authstore.Store's three methods exactly.
  statement {
    sid = "SessionsTableAccess"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
    ]
    resources = [aws_dynamodb_table.sessions.arn]
  }

  # Also separate from sessions above — different table, different access
  # pattern (see accounts_table.tf). Matches manifeststore.Store's two
  # methods exactly; no delete needed until account deletion is built.
  statement {
    sid = "AccountsTableAccess"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
    ]
    resources = [aws_dynamodb_table.accounts.arn]
  }

  # Also separate from every table above — its own table (see
  # modules/storage/dynamodb.tf's invites resource). Matches
  # invitestore.Store's method set exactly: no DeleteItem (nothing ever
  # deletes a row — eviction is TTL-only) and no TransactWriteItems (unlike
  # sync_log, nothing here needs cross-item atomicity).
  statement {
    sid = "InviteTableAccess"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
    ]
    resources = [module.storage.invite_table_arn]
  }

  statement {
    sid       = "KMSAccess"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.master.arn]
  }

  # No IAM statement for Google/Apple sign-in verification — internal/
  # oidcverify fetches each provider's JWKS over plain outbound HTTPS,
  # which needs no AWS permission at all (the Lambda has internet egress
  # by default outside a VPC).
}

resource "aws_iam_role_policy" "lambda_storage_access" {
  name   = "${local.name_prefix}-storage-access"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_storage_access.json
}

resource "aws_lambda_function" "relay" {
  function_name = "${local.name_prefix}-relay"
  role          = aws_iam_role.lambda.arn

  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256

  # Custom runtime for a natively-compiled Go binary — see
  # server/cmd/lambda. "handler" is unused by provided runtimes (they just
  # exec ./bootstrap) but Terraform requires a value.
  runtime       = "provided.al2023"
  handler       = "bootstrap"
  architectures = ["arm64"]

  timeout     = 10
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME               = module.storage.table_name
      BUCKET_NAME              = module.storage.bucket_name
      SESSIONS_TABLE_NAME      = aws_dynamodb_table.sessions.name
      ACCOUNTS_TABLE_NAME      = aws_dynamodb_table.accounts.name
      INVITE_TABLE_NAME        = module.storage.invite_table_name
      GOOGLE_CLIENT_ID_IOS     = var.google_client_id_ios
      GOOGLE_CLIENT_ID_ANDROID = var.google_client_id_android
      GOOGLE_CLIENT_ID_WEB     = var.google_client_id_web
      APPLE_CLIENT_ID_IOS      = var.apple_client_id_ios
      LOG_RETENTION_DAYS       = tostring(var.log_retention_days)
      MAX_BLOB_SIZE_BYTES      = tostring(var.max_blob_size_bytes)
      INVITE_RETENTION_DAYS    = tostring(var.invite_retention_days)
    }
  }
}
