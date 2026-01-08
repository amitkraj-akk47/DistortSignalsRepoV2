#!/bin/bash
# DistortSignals - CI Test Script
# Runs all tests across the monorepo

set -e

echo "🧪 Running DistortSignals test suite..."

# Run TypeScript tests
echo "📋 Testing TypeScript..."
pnpm test

# Run Python tests
echo "🐍 Testing Python..."
cd apps/python/signal-generator && poetry run pytest && cd ../../..
cd apps/python/trade-director && poetry run pytest && cd ../../..
cd apps/python/shared && poetry run pytest && cd ../../..

# Validate contracts
echo "🔍 Validating contracts..."
./tools/scripts/validate-contracts.sh

echo "✅ All tests passed!"
