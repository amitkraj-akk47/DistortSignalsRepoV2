#!/bin/bash
# Supabase Migration Deployment Script

set -e

ENVIRONMENT=${1:-production}

echo "🗄️  Deploying Supabase migrations to $ENVIRONMENT..."

# Check if supabase CLI is installed
if ! command -v supabase &> /dev/null; then
  echo "❌ Supabase CLI not installed"
  echo "Install: npm install -g supabase"
  exit 1
fi

# Check required environment variables
if [ -z "$SUPABASE_ACCESS_TOKEN" ]; then
  echo "❌ SUPABASE_ACCESS_TOKEN not set"
  exit 1
fi

# Link to project
if [ "$ENVIRONMENT" = "production" ]; then
  PROJECT_REF=${SUPABASE_PROJECT_REF_PROD}
else
  PROJECT_REF=${SUPABASE_PROJECT_REF_STAGING}
fi

echo "📎 Linking to project: $PROJECT_REF"
supabase link --project-ref "$PROJECT_REF"

# Push migrations
echo "🚀 Pushing migrations..."
supabase db push

# Verify migrations
echo "✅ Verifying migrations..."
supabase db remote commit

echo "✅ Migrations deployed successfully to $ENVIRONMENT!"
