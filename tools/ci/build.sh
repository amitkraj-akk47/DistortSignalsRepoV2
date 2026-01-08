#!/bin/bash
# DistortSignals - CI Build Script
# Builds all TypeScript and Python services

set -e

echo "🔨 Building DistortSignals..."

# Build TypeScript packages and apps
echo "📦 Building TypeScript workspace..."
pnpm build

# Lint TypeScript
echo "🔍 Linting TypeScript..."
pnpm lint

# Test TypeScript
echo "🧪 Testing TypeScript..."
pnpm test

# Build Python packages
echo "🐍 Building Python packages..."
cd apps/python/shared && poetry build && cd ../../..

# Test Python
echo "🧪 Testing Python..."
cd apps/python/signal-generator && poetry run pytest && cd ../../..
cd apps/python/trade-director && poetry run pytest && cd ../../..

echo "✅ Build complete!"
