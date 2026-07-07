output "vpc_id" {
  value = aws_vpc.main.id
}

output "db_endpoint" {
  value = aws_db_instance.main.endpoint
}

output "documents_bucket" {
  value = aws_s3_bucket.documents.bucket
}

output "redis_endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}
