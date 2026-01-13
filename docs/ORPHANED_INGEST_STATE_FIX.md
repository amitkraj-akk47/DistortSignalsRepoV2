# Database State Mismatch Issue - Orphaned Ingest State Records

**Issue Date**: 2026-01-13  
**Severity**: HIGH - Causes `exceededCpu` timeouts  
**Status**: RESOLVED

## Problem Statement

The tick-factory worker was experiencing `exceededCpu` timeouts due to stale ingestion state records:

- Asset records exist in `data_ingest_state` table (historical ingestion data)
- Same assets are marked as `active=false` and `test_active=false` in `core_asset_registry_all`
- Worker skips loading disabled assets, BUT orphaned state records remain in the database
- These orphaned records cause inefficient queries and potential RPC call issues

### Example Scenario
```
core_asset_registry_all:
  canonical_symbol | active | test_active
  EURUSD           | false  | false       ❌ Asset is disabled

data_ingest_state:
  canonical_symbol | timeframe | status
  EURUSD           | 1m        | running   ⚠️ Stale record exists!
```

## Root Causes

1. **Asset Lifecycle Mismatch**: Assets disabled after ingestion have started leave orphaned state
2. **No Cascade Cleanup**: Disabling an asset doesn't auto-delete its ingestion state
3. **Query Inefficiency**: RPC calls may need to scan/update stale records even though asset is inactive

## Solution

### Part 1: One-Time Database Cleanup (DONE)
Migration: [007_cleanup_orphaned_ingest_state.sql](../db/migrations/007_cleanup_orphaned_ingest_state.sql)

Removes all `data_ingest_state` records where the asset is no longer active:
```sql
DELETE FROM data_ingest_state dis
WHERE NOT EXISTS (
  SELECT 1 FROM core_asset_registry_all car
  WHERE dis.canonical_symbol = car.canonical_symbol
    AND (car.active = true OR car.test_active = true)
);
```

### Part 2: Preventative Measures
Add checks in worker code to:
- Validate asset state before processing
- Log warnings for stale state records
- Set hard timeout/budget limits to prevent CPU exhaustion

## Prevention Going Forward

1. **Add database constraint** (optional):
   ```sql
   -- On core_asset_registry_all UPDATE to inactive:
   -- DELETE FROM data_ingest_state WHERE canonical_symbol = $1
   ```

2. **Periodic cleanup** (recommended):
   ```sql
   -- Run daily via pg_cron
   SELECT cron.schedule('cleanup-orphaned-ingest-state', '0 3 * * *', $$
     DELETE FROM data_ingest_state dis
     WHERE NOT EXISTS (
       SELECT 1 FROM core_asset_registry_all car
       WHERE dis.canonical_symbol = car.canonical_symbol
         AND (car.active OR car.test_active)
     );
   $$);
   ```

3. **Worker validation** (recommended):
   Add pre-flight check before `ingest_asset_start` RPC:
   ```typescript
   // Validate asset is still active
   if (!asset.active && !asset.test_active) {
     log.warn("ASSET_DISABLED", "Asset is disabled but was loaded", { canonical });
     continue;
   }
   ```

## Testing & Validation

After applying migration:
1. ✅ Run: `SELECT COUNT(*) FROM data_ingest_state` - should be reduced
2. ✅ Run worker - should complete without `exceededCpu`
3. ✅ Check logs for `LOAD_ASSETS` count - should match assets processed

## Related Issues

- Previous: CPU timeout in tick-factory (2026-01-13 00:10:49 UTC)
- Lock mechanism: [WORKER_LOCK_AND_CONCURRENCY_ANALYSIS.md](./WORKER_LOCK_AND_CONCURRENCY_ANALYSIS.md)
- State management: [aggregator-pre-deployment-verification.md](./aggregator-pre-deployment-verification.md)
