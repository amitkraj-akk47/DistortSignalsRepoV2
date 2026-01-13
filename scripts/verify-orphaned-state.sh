#!/bin/bash
# Verification script: Check for orphaned data_ingest_state records
# Date: 2026-01-13

set -e

# Load environment
if [ ! -f "scripts/.env" ]; then
  echo "ERROR: scripts/.env not found"
  exit 1
fi

source scripts/.env

if [ -z "$PG_DSN" ]; then
  echo "ERROR: PG_DSN not set in scripts/.env"
  exit 1
fi

echo "=========================================="
echo "ORPHANED INGEST STATE VERIFICATION"
echo "=========================================="
echo ""

# Query 1: Count total ingest state records
echo "1. Total data_ingest_state records:"
psql "$PG_DSN" -t -c "SELECT COUNT(*) as total FROM data_ingest_state;" 2>/dev/null || {
  echo "❌ Failed to connect to database"
  exit 1
}
echo ""

# Query 2: Count orphaned records (disabled assets with state)
echo "2. Orphaned records (disabled assets with lingering state):"
psql "$PG_DSN" -t -c "
  SELECT COUNT(*) as orphaned_count 
  FROM data_ingest_state dis
  WHERE NOT EXISTS (
    SELECT 1 FROM core_asset_registry_all car
    WHERE dis.canonical_symbol = car.canonical_symbol
      AND (car.active = true OR car.test_active = true)
  );
" 2>/dev/null
echo ""

# Query 3: List orphaned records (if any exist)
echo "3. Details of orphaned records:"
psql "$PG_DSN" -H -t -c "
  SELECT 
    dis.canonical_symbol,
    dis.timeframe,
    dis.status,
    dis.hard_fail_streak,
    dis.last_attempted_to,
    dis.updated_at
  FROM data_ingest_state dis
  WHERE NOT EXISTS (
    SELECT 1 FROM core_asset_registry_all car
    WHERE dis.canonical_symbol = car.canonical_symbol
      AND (car.active = true OR car.test_active = true)
  )
  ORDER BY dis.canonical_symbol;
" 2>/dev/null || echo "No orphaned records found (or query failed)"
echo ""

# Query 4: Check for disabled assets that still have active state
echo "4. Disabled assets with state marked as 'running':"
psql "$PG_DSN" -H -t -c "
  SELECT 
    dis.canonical_symbol,
    dis.timeframe,
    dis.status,
    car.active,
    car.test_active
  FROM data_ingest_state dis
  JOIN core_asset_registry_all car ON dis.canonical_symbol = car.canonical_symbol
  WHERE (car.active = false AND car.test_active = false)
    AND dis.status = 'running'
  LIMIT 20;
" 2>/dev/null || echo "Query failed"
echo ""

echo "=========================================="
echo "VERIFICATION COMPLETE"
echo "=========================================="
