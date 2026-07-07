# 409.ai rebuild — infrastructure baseline (issue #1, architecture.md §6).
# VPC + RDS Postgres + S3 (documents) + ElastiCache Redis. Service compute
# (ECS/EKS) is added when the first environment is stood up.

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Remote state: configure per environment, e.g.
  # backend "s3" { bucket = "n409-terraform-state" key = "env/dev.tfstate" region = "us-east-1" }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "n409"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
