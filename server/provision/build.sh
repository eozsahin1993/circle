#!/usr/bin/env bash
# Compiles the Lambda's Go binary for provision/lambda.tf to zip up. Run
# this (from anywhere) whenever server/cmd/lambda or anything it depends
# on changes, before `terraform plan`/`terraform apply` — Terraform reads
# the already-built binary, it doesn't invoke `go build` itself.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."  # server/ — the Go module root
mkdir -p provision/build

GOOS=linux GOARCH=arm64 go build -o provision/build/bootstrap ./cmd/lambda

echo "Built provision/build/bootstrap ($(du -h provision/build/bootstrap | cut -f1))"
