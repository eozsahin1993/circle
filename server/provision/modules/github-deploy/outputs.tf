output "role_arn" {
  description = "Set this as AWS_ROLE_ARN on the GitHub Environment of the same name."
  value       = aws_iam_role.deploy.arn
}
