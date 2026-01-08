#!/bin/bash
# DistortSignals - Database Migration Runner
# Usage: ./migrate.sh [up|down|status]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIGRATIONS_DIR="$PROJECT_ROOT/db/migrations"

# Load environment variables
if [ -f "$PROJECT_ROOT/.env" ]; then
  export $(grep -v '^#' "$PROJECT_ROOT/.env" | xargs)
fi

ACTION=${1:-status}

case $ACTION in
  up)
    echo "Running migrations..."
    # Add your migration tool command here
    # Example: psql $DATABASE_URL -f $MIGRATIONS_DIR/*.sql
    ;;
  down)
    echo "Rolling back migrations..."
    # Add rollback logic here
    ;;
  status)
    echo "Checking migration status..."
    # Add status check logic here
    ;;
  *)
    echo "Usage: $0 [up|down|status]"
    exit 1
    ;;
esac
