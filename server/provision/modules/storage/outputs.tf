output "table_name" {
  value = aws_dynamodb_table.sync_log.name
}

output "table_arn" {
  value = aws_dynamodb_table.sync_log.arn
}

output "bucket_name" {
  value = aws_s3_bucket.circle_blobs.id
}

output "bucket_arn" {
  value = aws_s3_bucket.circle_blobs.arn
}
