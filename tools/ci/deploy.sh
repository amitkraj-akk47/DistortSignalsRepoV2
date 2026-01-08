#!/bin/bash
# DistortSignals - CI Deploy Script
# Deploys all services to production

set -e

echo "🚀 Deploying DistortSignals..."

# Check environment
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  echo "❌ CLOUDFLARE_API_TOKEN not set"
  exit 1
fi

# Deploy Cloudflare Workers
echo "☁️  Deploying Cloudflare Workers..."
cd apps/typescript/tick-factory && pnpm deploy && cd ../../..
cd apps/typescript/communication-hub && pnpm deploy && cd ../../..
cd apps/typescript/public-api && pnpm deploy && cd ../../..
cd apps/typescript/director-endpoints && pnpm deploy && cd ../../..

# Deploy Python services
echo "🐍 Deploying Python services..."
# Add deployment logic for Python services here

echo "✅ Deployment complete!"
