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
      "dynamodb:DeleteItem",
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
      TABLE_NAME       = module.storage.table_name
      BUCKET_NAME      = module.storage.bucket_name
      RING_BUFFER_SIZE = tostring(var.ring_buffer_size)
    }
  }
}
