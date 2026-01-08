#!/bin/bash
# DistortSignals - Development Environment Setup
# Sets up the complete development environment

set -e

echo "🚀 Setting up DistortSignals development environment..."

# Install TypeScript dependencies
echo "📦 Installing TypeScript dependencies..."
pnpm install

# Install Python dependencies
echo "🐍 Setting up Python environments..."
cd apps/python/shared && poetry install && cd ../../..
cd apps/python/signal-generator && poetry install && cd ../../..
cd apps/python/trade-director && poetry install && cd ../../..

# Create .env template if it doesn't exist
if [ ! -f .env ]; then
  echo "📝 Creating .env template..."
  cat > .env << 'EOF'
# Database
SUPABASE_URL=your-supabase-url
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-key

# Cloudflare
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token

# Application
NODE_ENV=development
LOG_LEVEL=debug
EOF
  echo "⚠️  Please update .env with your credentials"
fi

echo "✅ Development environment setup complete!"
echo ""
echo "Next steps:"
echo "  1. Update .env with your credentials"
echo "  2. Run 'pnpm dev' to start all services"
echo "  3. See README.md for more information"
