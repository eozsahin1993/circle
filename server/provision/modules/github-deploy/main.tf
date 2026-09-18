# The identity GitHub Actions deploys as: a role it assumes through OIDC,
# so nothing long-lived exists to leak. GitHub presents a signed token
# describing the repo, branch and environment; AWS checks it against the
# trust policy below and hands back credentials that expire in an hour.
#
# The boundary is that trust policy, not the permission set. Terraform
# manages IAM itself, so anything able to apply this configuration can
# grant itself the rest — a narrowly-scoped deploy policy would be theatre
# and would break every time a resource type is added.

# One per account, shared by every role that trusts GitHub. AWS verifies
# the endpoint against its own trust store now, so the thumbprint is
# vestigial — but the argument is still required.
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["ffffffffffffffffffffffffffffffffffffffff"]
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # The environment, not just the repo: a workflow that doesn't declare
    # `environment: <name>` can't assume this role. So the environment's
    # own protection rules — required reviewers, which branches may deploy
    # — are what gates a deploy, rather than the honesty of a workflow file
    # anyone can open a PR against.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.repository}:environment:${var.environment}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "${var.name_prefix}-github-deploy"
  description        = "Assumed by GitHub Actions to deploy ${var.name_prefix}"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy_attachment" "deploy" {
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}
