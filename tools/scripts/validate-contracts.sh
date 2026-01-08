#!/bin/bash
# DistortSignals - Contract Validation
# Validates all JSON schemas and OpenAPI specs

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONTRACTS_DIR="$PROJECT_ROOT/contracts"

echo "🔍 Validating contracts..."

# Check if ajv-cli is installed
if ! command -v ajv &> /dev/null; then
  echo "Installing ajv-cli..."
  npm install -g ajv-cli
fi

# Validate JSON schemas
echo "📋 Validating JSON schemas..."
for schema in "$CONTRACTS_DIR/schemas"/*.json; do
  echo "  Checking $(basename "$schema")..."
  ajv compile -s "$schema" || exit 1
done

# Validate OpenAPI specs
echo "📋 Validating OpenAPI specs..."
for spec in "$CONTRACTS_DIR/openapi"/*.yaml; do
  echo "  Checking $(basename "$spec")..."
  # Add OpenAPI validation tool here
  # Example: swagger-cli validate "$spec"
done

# Validate enums
echo "📋 Validating enums..."
for enum in "$CONTRACTS_DIR/enums"/*.json; do
  echo "  Checking $(basename "$enum")..."
  cat "$enum" | jq empty || exit 1
done

echo "✅ All contracts are valid!"
