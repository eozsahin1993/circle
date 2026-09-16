# The pre-built Go binary — see build.sh. Terraform doesn't invoke `go
# build` itself (kept as a separate, explicit step rather than a
# provisioner): run ./build.sh before `terraform apply`/`terraform plan`
# whenever the Go source changes.
data "archive_file" "lambda" {
  type        = "zip"
  source_file = var.binary_path
  output_path = "${path.root}/.terraform/lambda.zip"
}

# Every relay setting that varies by env (sign-in client IDs, APNs IDs,
# limits), uploaded from server/<env>.env by push-config.sh. Read at apply
# time and baked into the function's environment under the same names —
# so a changed setting needs push-config.sh and then `terraform apply`.
data "aws_ssm_parameters_by_path" "config" {
  path = "/${var.name_prefix}/config"
}

locals {
  config = zipmap(
    [for name in data.aws_ssm_parameters_by_path.config.names : basename(name)],
    data.aws_ssm_parameters_by_path.config.values,
  )
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
  name               = "${var.name_prefix}-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# One statement per table, each matching its store's calls exactly — no
# wildcard resource ARNs. LocalStack doesn't enforce IAM, so a missing
# action here passes every local test and only fails once deployed:
# re-check against the store when one gains a call.
data "aws_iam_policy_document" "lambda_storage_access" {
  # internal/synclog/dynamodb. The index ARN is for DeleteEntry's
  # entryId-index lookup.
  statement {
    sid = "SyncLogTableAccess"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:TransactWriteItems",
    ]
    resources = [var.storage.table_arn, "${var.storage.table_arn}/index/*"]
  }

  statement {
    sid = "S3Access"
    actions = [
      "s3:PutObject",
      # HeadObject as well as reads: the upload path checks for an existing
      # object, and deleteblob reads back the uploader recorded on it.
      "s3:GetObject",
      # A post's ciphertext, one at a time or in DeleteObjects batches —
      # never a log entry (see internal/synclog/http/deleteblob).
      "s3:DeleteObject",
    ]
    resources = ["${var.storage.bucket_arn}/*"]
  }

  # Deleting a circle lists everything under its prefix first — a
  # bucket-level action, so it can't share the object ARN above.
  statement {
    sid       = "S3ListAccess"
    actions   = ["s3:ListBucket"]
    resources = [var.storage.bucket_arn]
  }

  # internal/auth/dynamodb. Query on accountId-index is DeleteAllSessions,
  # which account deletion uses to revoke every session at once.
  statement {
    sid = "SessionsTableAccess"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
    ]
    resources = [var.storage.sessions_table_arn, "${var.storage.sessions_table_arn}/index/*"]
  }

  # internal/account/dynamodb — DeleteItem is account deletion.
  statement {
    sid = "AccountsTableAccess"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
    ]
    resources = [var.storage.accounts_table_arn]
  }

  # internal/invite/dynamodb. DeleteItem is for "not now" dismissal only —
  # most rows still just age out under TTL. No TransactWriteItems (unlike
  # sync_log, nothing here needs cross-item atomicity).
  statement {
    sid = "InviteTableAccess"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
    ]
    resources = [var.storage.invite_table_arn]
  }

  # internal/ratelimit/dynamodb — Allow's two-attempt CAS is entirely
  # UpdateItem, no GetItem.
  statement {
    sid       = "RateLimitTableAccess"
    actions   = ["dynamodb:UpdateItem"]
    resources = [var.storage.rate_limit_table_arn]
  }

  # internal/push/dynamodb. UpdateItem is SetSilenced. No Scan — nothing
  # here ever enumerates the table, which is also what keeps a full read
  # of it off the hot path.
  statement {
    sid = "PushTableAccess"
    actions = [
      "dynamodb:PutItem",
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
      "dynamodb:DeleteItem",
    ]
    resources = [var.storage.push_table_arn]
  }

  # The FCM service-account key and APNs auth key, created by hand at
  # /<prefix>/fcm-service-account and /<prefix>/apns-auth-key (the paths
  # internal/config derives) and deliberately not Terraform resources —
  # declaring them would put the values in state. Scoped to the two
  # parameters, not "*": either key can put arbitrary text on every
  # user's lock screen.
  statement {
    sid     = "PushCredentialAccess"
    actions = ["ssm:GetParameter"]
    resources = [
      "arn:aws:ssm:${var.aws_region}:*:parameter/${var.name_prefix}/fcm-service-account",
      "arn:aws:ssm:${var.aws_region}:*:parameter/${var.name_prefix}/apns-auth-key",
    ]
  }

  # SecureStrings under the AWS-managed aws/ssm key: GetParameter's
  # WithDecryption decrypts as the caller, and only through SSM.
  statement {
    sid       = "PushCredentialDecrypt"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.aws_region}.amazonaws.com"]
    }
  }

  # No IAM statement for Google/Apple sign-in verification — internal/
  # auth/oidcverify fetches each provider's JWKS over plain outbound HTTPS,
  # which needs no AWS permission at all (the Lambda has internet egress
  # by default outside a VPC).
}

resource "aws_iam_role_policy" "lambda_storage_access" {
  name   = "${var.name_prefix}-storage-access"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_storage_access.json
}

resource "aws_lambda_function" "relay" {
  function_name = "${var.name_prefix}-relay"
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
    variables = merge(local.config, { RESOURCE_PREFIX = var.name_prefix })
  }
}
