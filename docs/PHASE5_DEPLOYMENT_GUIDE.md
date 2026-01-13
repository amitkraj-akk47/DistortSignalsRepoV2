# Phase 5 Migration: Complete Deployment Guide

**Status**: Ready to deploy  
**Files Created**:
- `db/migrations/011_aggregation_redesign.sql` - Main migration
- `db/migrations/011_aggregation_redesign_ROLLBACK.sql` - Safe rollback
- `docs/PHASE5_DEPLOYMENT_GUIDE.md` - This file

**Timeline**: ~20 minutes execution + 24 hours monitoring

---

## What This Migration Does

### Schema Changes
1. ✅ Adds 3 columns to `data_agg_state`:
   - `agg_start_utc` - Unified start date (2025-07-01 00:00:00+00)
   - `enabled` - Task control flag (default true)
   - `task_priority` - Scheduling priority (default 100)

2. ✅ Creates index for task selection by priority

### Function Updates
1. ✅ **agg_bootstrap_cursor()** - Now deterministic (no data dependency, no UNION ALL)
2. ✅ **catchup_aggregation_range()** - Enforces agg_start_utc guard, no UNION ALL
3. ✅ **agg_get_due_tasks()** - Enhanced with task_priority ordering
4. ✅ **agg_finish()** - Mandatory tasks get `hard_failed` status (never auto-disabled)
5. ✅ **sync_agg_state_from_registry()** - NEW: Auto-sync tasks from registry

### Design Guarantees
- Every asset starts at same agg_start_utc boundary (deterministic)
- No UNION ALL in bootstrap or catchup
- Frontier detection via source_count=0 (immediate stop)
- Mandatory tasks never auto-disable (hard_failed instead)
- Task priority field enables future scheduling enhancements

---

## Pre-Deployment Checklist

### 1. Backup Current State
```bash
# Backup functions (optional but recommended)
pg_dump -h <host> -U postgres -d postgres \
  --schema-only \
  -t data_agg_state \
  > backup_agg_state_$(date +%Y%m%d_%H%M%S).sql

# Backup data
psql -h <host> -U postgres -d postgres -c \
  "SELECT * FROM data_agg_state;" \
  > backup_agg_state_data_$(date +%Y%m%d_%H%M%S).csv
```

### 2. Verify Current State
```sql
-- Check function signatures exist
SELECT proname, pg_get_functiondef(oid)
FROM pg_proc
WHERE proname IN ('agg_bootstrap_cursor', 'catchup_aggregation_range', 'agg_finish', 'agg_get_due_tasks')
ORDER BY proname;

-- Check no stuck running tasks
SELECT COUNT(*) as stuck_tasks
FROM data_agg_state
WHERE status = 'running' AND running_started_at_utc < (NOW() - INTERVAL '30 minutes');
```

### 3. Verify Data Integrity
```sql
-- No NULL cursors
SELECT COUNT(*) FROM data_agg_state WHERE last_agg_bar_ts_utc IS NULL;

-- All mandatory tasks enabled
SELECT COUNT(*) FROM data_agg_state WHERE is_mandatory = true;

-- Check for orphaned tasks
SELECT s.canonical_symbol, s.timeframe
FROM data_agg_state s
LEFT JOIN core_asset_registry_all a ON a.canonical_symbol = s.canonical_symbol
WHERE a.canonical_symbol IS NULL;
```

### 4. Plan Maintenance Window
- **Best Time**: Off-market hours (no active aggregation)
- **Duration**: 15 minutes execution + 5 minutes verification
- **Monitoring**: 24 hours post-deploy

---

## Deployment Steps

### Step 1: Connect to Database
```bash
# Supabase CLI (if using)
supabase db push

# OR direct psql
psql -h <supabase-host> -U postgres -d postgres -c \
  "\i db/migrations/011_aggregation_redesign.sql"
```

### Step 2: Run Migration
```bash
# Execute the migration
psql -h <host> -U postgres -d postgres < db/migrations/011_aggregation_redesign.sql

# Expected output:
# BEGIN
# CREATE INDEX
# DROP FUNCTION (× 5 old versions if upgrading)
# CREATE FUNCTION agg_bootstrap_cursor
# CREATE FUNCTION catchup_aggregation_range
# CREATE FUNCTION agg_finish
# CREATE FUNCTION agg_get_due_tasks
# CREATE FUNCTION sync_agg_state_from_registry
# NOTICE: Phase 5 Migration Complete: 6 total tasks, 6 enabled, 0 hard_failed
# COMMIT
```

### Step 3: Verify Schema
```sql
-- Check columns exist
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'data_agg_state'
  AND column_name IN ('agg_start_utc', 'enabled', 'task_priority')
ORDER BY ordinal_position;
-- Expected: 3 rows (agg_start_utc timestamptz, enabled boolean, task_priority integer)

-- Check functions exist and are correct
SELECT proname, prosecdef, proowner::regrole
FROM pg_proc
WHERE proname IN ('agg_bootstrap_cursor', 'catchup_aggregation_range', 'agg_finish', 
                  'agg_get_due_tasks', 'sync_agg_state_from_registry')
ORDER BY proname;
-- Expected: 5 rows, all with prosecdef=true (SECURITY DEFINER)

-- Check index exists
SELECT indexname FROM pg_indexes
WHERE tablename = 'data_agg_state' AND indexname = 'idx_agg_state_due_priority';
-- Expected: 1 row
```

### Step 4: Verify Data
```sql
-- Check all tasks have agg_start_utc set
SELECT COUNT(*) as null_start_dates FROM data_agg_state WHERE agg_start_utc IS NULL;
-- Expected: 0

-- Check all tasks enabled by default
SELECT COUNT(*) as disabled_tasks FROM data_agg_state WHERE enabled = false;
-- Expected: 0 (unless you disabled some intentionally)

-- Check task_priority defaults
SELECT COUNT(DISTINCT task_priority) FROM data_agg_state;
-- Expected: 1 (all set to 100)

-- Verify no hard_failed tasks yet
SELECT COUNT(*) as hard_failed FROM data_agg_state WHERE status = 'hard_failed';
-- Expected: 0 (none created until a mandatory task fails)
```

### Step 5: Test Functions
```sql
-- Test agg_bootstrap_cursor (should align to 2025-07-01 boundary)
SELECT agg_bootstrap_cursor('EURUSD', '5m');
-- Expected: 2025-07-01 00:00:00+00 (or nearest 5m boundary after)

-- Test agg_get_due_tasks (should return all idle tasks)
SELECT COUNT(*) FROM agg_get_due_tasks('prod', NOW());
-- Expected: 6 (or however many tasks you have)

-- Test sync_agg_state_from_registry
SELECT sync_agg_state_from_registry('prod', '2025-07-01 00:00:00+00');
-- Expected: success=true, tasks_created/updated count

-- Test catchup_aggregation_range (won't store bars without source data, but should not error)
SELECT catchup_aggregation_range('EURUSD', '5m', '2025-07-01 00:00:00+00'::timestamptz, 1);
-- Expected: success=true, windows_processed=0 (no source data before 2025-07-01)
```

---

## Post-Deployment Monitoring (24 Hours)

### Hour 1: Verify Execution
```sql
-- Check aggregation is running
SELECT s.canonical_symbol, s.timeframe, s.status,
       NOW() - s.last_successful_at_utc as time_since_last_success,
       s.last_error
FROM data_agg_state s
ORDER BY s.canonical_symbol, s.timeframe;

-- Should see:
-- - status = idle (task completed)
-- - time_since_last_success < 1 minute (recent run)
-- - last_error = NULL (no errors)
```

### Hours 1-24: Monitor Key Metrics
```sql
-- 1. Aggregation Lag
SELECT s.canonical_symbol, s.timeframe,
       MAX(db.ts_utc) as latest_1m_bar,
       s.last_agg_bar_ts_utc as cursor_position,
       MAX(db.ts_utc) - s.last_agg_bar_ts_utc as lag_duration
FROM data_bars db
JOIN data_agg_state s ON s.canonical_symbol = db.canonical_symbol
WHERE db.timeframe = '1m'
GROUP BY s.canonical_symbol, s.timeframe, s.last_agg_bar_ts_utc
ORDER BY lag_duration DESC NULLS LAST;

-- Expected: lag < 1 hour for all mandatory tasks

-- 2. Failure Rate
SELECT COUNT(*) as total_tasks,
       COUNT(*) FILTER (WHERE hard_fail_streak > 0) as failing_tasks,
       COUNT(*) FILTER (WHERE status = 'hard_failed') as hard_failed,
       COUNT(*) FILTER (WHERE status = 'disabled') as disabled
FROM data_agg_state;

-- Expected: failing_tasks=0, hard_failed=0, disabled=0

-- 3. Data Quality
SELECT ddb.canonical_symbol, ddb.timeframe,
       COUNT(*) as total_bars,
       COUNT(*) FILTER (WHERE quality_score >= 1) as good_bars,
       ROUND(100.0 * COUNT(*) FILTER (WHERE quality_score >= 1) / COUNT(*), 2) as quality_pct
FROM derived_data_bars ddb
WHERE ddb.deleted_at IS NULL
  AND ddb.ts_utc >= NOW() - INTERVAL '24 hours'
GROUP BY ddb.canonical_symbol, ddb.timeframe;

-- Expected: quality_pct >= 90% for all timeframes

-- 4. Index Usage
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM agg_get_due_tasks('prod', NOW());
-- Expected: Index Scan on idx_agg_state_due_priority
```

### Alert Conditions
```sql
-- Create alert if:
-- 1. Any mandatory task has lag > 1 hour
SELECT s.canonical_symbol, s.timeframe
FROM data_agg_state s
WHERE s.is_mandatory = true
  AND NOW() - COALESCE(s.last_agg_bar_ts_utc, '1970-01-01') > INTERVAL '1 hour';

-- 2. Any task in hard_failed status
SELECT * FROM data_agg_state WHERE status = 'hard_failed';

-- 3. Any task with hard_fail_streak > 0
SELECT * FROM data_agg_state WHERE hard_fail_streak > 0;
```

---

## If Issues Occur

### Issue: Functions throw "Missing config in data_agg_state"
```sql
-- Check task exists
SELECT * FROM data_agg_state WHERE canonical_symbol = 'EURUSD' AND timeframe = '5m';

-- Fix: Sync from registry
SELECT sync_agg_state_from_registry('prod', '2025-07-01 00:00:00+00');
```

### Issue: Aggregation doesn't start
```sql
-- Check if worker has permission
SELECT * FROM pg_user WHERE usename = 'service_role';

-- Check function permissions
SELECT aclexplode(proacl) FROM pg_proc WHERE proname = 'agg_get_due_tasks';

-- Re-grant if needed
GRANT EXECUTE ON FUNCTION agg_get_due_tasks(text, timestamptz, int, int) TO service_role;
```

### Issue: Cursor stuck before 2025-07-01
```sql
-- Bootstrap should have set it correctly
SELECT agg_bootstrap_cursor('EURUSD', '5m');

-- If still wrong, manually set:
UPDATE data_agg_state
SET last_agg_bar_ts_utc = '2025-07-01 00:00:00+00'::timestamptz
WHERE canonical_symbol = 'EURUSD' AND timeframe = '5m';
```

### Issue: Need to rollback
```bash
# Run rollback script
psql -h <host> -U postgres -d postgres < db/migrations/011_aggregation_redesign_ROLLBACK.sql

# Then restore old functions from backup (if you have them)
# OR wait for your deployment tool to revert via previous migration
```

---

## Success Criteria

✅ **Phase 5 Deployed Successfully When:**

1. ✅ Migration executes without errors
2. ✅ All 3 new columns exist and populated
3. ✅ All 5 functions exist and correct
4. ✅ Index created on data_agg_state
5. ✅ All tasks have agg_start_utc = 2025-07-01
6. ✅ Aggregation lag < 1 hour for all mandatory tasks
7. ✅ Zero hard_fail_streak (no failures)
8. ✅ Zero hard_failed tasks (no mandatory failures)
9. ✅ Quality metrics stable (>90% good bars)
10. ✅ 24-hour monitoring shows green metrics

---

## Operational Notes

### Bootstrap Behavior Change
**Before**: Bootstrap returned next boundary after NOW() if no data, else looked at latest data
**After**: Bootstrap always returns agg_start_utc aligned boundary (deterministic)

**Impact**: Tasks will always start at the same time across all assets, independent of data volume. This is safer and more predictable.

### Frontier Detection No Change
**Still**: Stop immediately when source_count=0
**Still**: Rely on next run to pick up after gap
**Enhanced**: agg_start_utc guard prevents processing before unified start date

### Mandatory Task Behavior Change
**Before**: Auto-disable after 3 hard failures regardless of mandatory status
**After**: 
- Mandatory tasks → hard_failed (excluded from scheduling, manual reset required)
- Optional tasks → disabled (as before)

**Impact**: Mandatory aggregation tasks won't accidentally disable themselves. Hard failures are visible and require explicit acknowledgment to reset.

### Task Priority Field
**What it is**: New column (default 100) for future scheduling priority customization
**Current use**: Default 100 for all tasks
**Future use**: Lower values = higher priority (allows fine-tuning task order)

---

## Files for Reference

1. **Migration**: `db/migrations/011_aggregation_redesign.sql`
2. **Rollback**: `db/migrations/011_aggregation_redesign_ROLLBACK.sql`
3. **Design**: [Original docs in /workspaces/DistortSignalsRepoV2/docs/]

---

## Questions?

Refer to:
- **Design rationale**: PHASE5_REVIEW_EXECUTIVE_SUMMARY.md
- **Critical issues addressed**: PHASE5_CRITICAL_ISSUES_AND_FIXES.md
- **Implementation details**: PHASE5_CORRECTED_IMPLEMENTATION.md

---

**Status**: 🟢 Ready to deploy

**Next Step**: Run migration in target environment, monitor 24 hours, then proceed with Phase 6 testing.
