#!/bin/bash
# Cloudflare Worker Deployment Script
# Deploys all workers to specified environment

set -e

ENVIRONMENT=${1:-production}

echo "🚀 Deploying Cloudflare Workers to $ENVIRONMENT..."

# Check required environment variables
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  echo "❌ CLOUDFLARE_API_TOKEN not set"
  exit 1
fi

WORKERS=(
  "tick-factory"
  "communication-hub"
  "public-api"
  "director-endpoints"
)

for worker in "${WORKERS[@]}"; do
  echo "📦 Deploying $worker..."
  cd "../../apps/typescript/$worker"
  wrangler deploy --env "$ENVIRONMENT"
  cd -
done

echo "✅ All workers deployed to $ENVIRONMENT!"
