-- Cleanup: Remove orphaned data_ingest_state records for disabled assets
-- Date: 2026-01-13
-- Issue: Assets disabled in core_asset_registry_all but still have state records
-- This can cause CPU timeouts and query inefficiencies

BEGIN;

-- Identify orphaned state records (before deletion for audit)
-- SELECT dis.canonical_symbol, dis.timeframe, dis.status, dis.last_error
-- FROM data_ingest_state dis
-- LEFT JOIN core_asset_registry_all car ON dis.canonical_symbol = car.canonical_symbol
-- WHERE car.canonical_symbol IS NULL OR (car.active = false AND car.test_active = false);

-- Delete state records where asset is completely disabled in registry
DELETE FROM data_ingest_state dis
WHERE NOT EXISTS (
  SELECT 1 FROM core_asset_registry_all car
  WHERE dis.canonical_symbol = car.canonical_symbol
    AND (car.active = true OR car.test_active = true)
);

-- Log the cleanup
INSERT INTO audit_log (entity_type, entity_id, action, changed_by, changes, occurred_at)
SELECT 
  'data_ingest_state' as entity_type,
  canonical_symbol as entity_id,
  'DELETE' as action,
  'database_maintenance' as changed_by,
  jsonb_build_object('reason', 'cleanup_orphaned_records_for_disabled_assets') as changes,
  NOW() as occurred_at
FROM (
  SELECT dis.canonical_symbol
  FROM data_ingest_state dis
  LEFT JOIN core_asset_registry_all car ON dis.canonical_symbol = car.canonical_symbol
  WHERE car.canonical_symbol IS NULL OR (car.active = false AND car.test_active = false)
) orphans;

COMMIT;
