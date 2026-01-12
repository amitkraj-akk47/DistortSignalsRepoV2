# Aggregator Cursor Bug - Deployment Runbook

## Quick Reference

**Migration Files**:
- ✅ `/workspaces/DistortSignalsRepoV2/db/migrations/004_fix_aggregator_cursor.sql`
- ✅ `/workspaces/DistortSignalsRepoV2/db/migrations/005_reset_aggregator_cursors.sql`

**Timeline**: 2 hours hands-on + 24h monitoring

## Pre-Flight Checklist

Run these verification queries BEFORE deploying:

```sql
-- 1. Confirm cursors are ahead of source data
WITH latest AS (
  SELECT canonical_symbol, MAX(ts_utc) AS latest_1m
  FROM data_bars WHERE timeframe='1m'
  GROUP BY canonical_symbol
)
SELECT
  s.canonical_symbol,
  s.timeframe,
  s.last_agg_bar_ts_utc AS cursor,
  l.latest_1m AS max_source,
  s.last_agg_bar_ts_utc - l.latest_1m AS gap,
  s.total_runs,
  s.total_bars_created,
  ROUND(s.total_bars_created::numeric / NULLIF(s.total_runs, 0), 2) AS bars_per_run
FROM data_agg_state s
JOIN latest l USING (canonical_symbol)
WHERE s.timeframe='5m'
ORDER BY s.canonical_symbol;
-- Expected: gap > 0 (cursor ahead), low bars_per_run (~0.01)

-- 2. Verify window functions return source_count
SELECT prosrc FROM pg_proc WHERE proname = 'aggregate_1m_to_5m_window';
-- Must contain: 'source_count',v_cnt in RETURN statements
```

## Deployment Steps

### Step 1: Backup (5 min)

```sql
-- Create backup
CREATE TABLE data_agg_state_backup_20260111 AS 
SELECT * FROM data_agg_state;

-- Verify backup
SELECT COUNT(*), 
       COUNT(DISTINCT canonical_symbol || timeframe) as unique_tasks
FROM data_agg_state_backup_20260111;
```

### Step 2: Deploy Function Fix (5 min)

```bash
cd /workspaces/DistortSignalsRepoV2

# Deploy migration 004 (HARDENED with production safeguards)
psql $DATABASE_URL < db/migrations/004_fix_aggregator_cursor.sql
```

**Expected output**:
```
BEGIN
DROP FUNCTION
CREATE FUNCTION
REVOKE
GRANT
COMMIT
```

**Production Hardenings Applied**:
- ✅ NULL cursor guard (prevents bootstrap bypass)
- ✅ JSON contract validation (detects schema changes)
- ✅ Cursor monotonicity assertion (catches logic bugs)
- ✅ max_source_ts in response (observability)

### Step 3: Verify Function Update (5 min)

```sql
-- Check function was updated
SELECT 
  p.proname,
  pg_get_functiondef(p.oid) LIKE '%v_source_rows%' as has_source_rows_var,
  pg_get_functiondef(p.oid) LIKE '%IF v_source_rows = 0%' as has_exit_logic
FROM pg_proc p
WHERE p.proname = 'catchup_aggregation_range';
-- Expected: both columns = true

-- Test the safety check
SELECT catchup_aggregation_range(
  'EURUSD',
  '5m',
  '2026-01-11 10:00:00+00',  -- Far in future
  5,
  NOW(),
  1,
  true
);
-- Expected: {"success": true, "windows_processed": 0, "reason": "cursor_beyond_source_data", ...}
```

### Step 4: Deploy Cursor Reset (5 min)

```bash
# Deploy migration 005 (HARDENED with validation)
psql $DATABASE_URL < db/migrations/005_reset_aggregator_cursors.sql
```

**Expected output**:
```
BEGIN
UPDATE <N>  -- 5m tasks updated
UPDATE <M>  -- 1h tasks updated
DO
NOTICE: DXY cursor reset successfully: cursor=..., max_source=...
DO
NOTICE: Cursor reset complete: 5m tasks=N, 1h tasks=M
DO
NOTICE: Post-reset validation: All cursors within valid range
COMMIT
```

**Production Hardenings Applied**:
- ✅ Tightened reset condition (cursor >= max_ts OR NULL)
- ✅ Post-reset validation (proves no cursor ahead)
- ✅ DXY-specific verification

### Step 5: Verify Cursor Positions (5 min)

```sql
-- 1. All cursors should be within valid range
WITH latest AS (
  SELECT canonical_symbol, MAX(ts_utc) AS latest_1m
  FROM data_bars WHERE timeframe='1m'
  GROUP BY canonical_symbol
)
SELECT
  s.canonical_symbol,
  s.timeframe,
  s.last_agg_bar_ts_utc AS cursor,
  l.latest_1m AS max_source,
  (s.last_agg_bar_ts_utc > l.latest_1m) AS cursor_ahead
FROM data_agg_state s
JOIN latest l USING (canonical_symbol)
WHERE s.timeframe='5m'
ORDER BY s.canonical_symbol;
-- Expected: ALL cursor_ahead = false

-- 2. Verify next window has data
SELECT 
  canonical_symbol,
  timeframe,
  last_agg_bar_ts_utc,
  (
    SELECT COUNT(*) 
    FROM data_bars db 
    WHERE db.canonical_symbol = s.canonical_symbol 
      AND db.timeframe = s.source_timeframe
      AND db.ts_utc >= s.last_agg_bar_ts_utc
      AND db.ts_utc < s.last_agg_bar_ts_utc + make_interval(mins => run_interval_minutes)
  ) as source_bars_available
FROM data_agg_state s
WHERE timeframe IN ('5m', '1h')
  AND status = 'idle'
ORDER BY canonical_symbol, timeframe;
-- Expected: source_bars_available > 0 for all idle tasks
```

### Step 6: Manual Function Test (10 min)

```sql
-- Test with one symbol before waiting for cron
-- Record current state
SELECT last_agg_bar_ts_utc, total_bars_created 
FROM data_agg_state 
WHERE canonical_symbol='EURUSD' AND timeframe='5m';

-- Run aggregation manually
SELECT catchup_aggregation_range(
  'EURUSD',
  '5m',
  (SELECT last_agg_bar_ts_utc FROM data_agg_state 
   WHERE canonical_symbol='EURUSD' AND timeframe='5m'),
  5,  -- Small window count
  NOW(),
  1,
  true  -- Ignore confirmation
);

-- Expected response:
-- {
--   "success": true,
--   "windows_processed": N (1-5),
--   "cursor_advanced_to": "<timestamp>",
--   "bars_created": N (1-5),
--   "bars_skipped": 0 or small number,
--   ...
-- }

-- Verify bars were created
SELECT 
  COUNT(*) as new_bars,
  MIN(ts_utc) as oldest,
  MAX(ts_utc) as newest
FROM derived_data_bars
WHERE canonical_symbol = 'EURUSD' 
  AND timeframe = '5m'
  AND deleted_at IS NULL
  AND updated_at >= NOW() - INTERVAL '5 minutes';
```

### Step 7: Monitor Cron Run (5-10 min)

```bash
# Tail aggregator logs
cd /workspaces/DistortSignalsRepoV2/apps/typescript/aggregator
pnpm tail:dev

# Watch for:
# - "[AGG] Found N due tasks"
# -Use the new monitoring view for comprehensive health check
SELECT * FROM v_aggregation_frontier_health
ORDER BY canonical_symbol, timeframe;

-- Expected:
-- - cursor_status = 'OK' for all
-- - bars_per_run > 0.01 (much better than ~0.01 pre-fix)
-- - minutes_since_success < 60
-- - hard_fail_streak = 0

-- Check for any issues
SELECT * FROM v_aggregation_frontier_health
WHERE cursor_status != 'OK'
   OR minutes_since_success > 60
   OR hard_fail_streak > 0;
-- Should return 0 rows
```

### Step 9: Deploy Monitoring View (Optional, 2 min)

```bash
# Deploy monitoring view for ongoing health checks
psql $DATABASE_URL < db/migrations/006_aggregation_monitoring_view.sql
WHERE timeframe IN ('5m', '1h')
ORDER BY canonical_symbol, timeframe;

-- Expected:
-- - minutes_since_success < 60 for all
-- - hard_fail_streak = 0
-- - total_bars_created increasing since deployment
```

## Success Criteria

✅ **Deployment successful when**:
1. Function updated (has v_source_rows variable)
2. All cursors <= max available source timestamp
3. Manual test shows bars_created > 0
4. Cron run shows bars_created > 0
5. No hard_fail_streak > 0
6. All tasks have recent last_successful_at_utc

## Rollback Procedure

If issues arise:

```sql
BEGIN;

-- 1. Restore state
DELETE FROM data_agg_state;
INSERT INTO data_agg_state 
SELECT * FROM data_agg_state_backup_20260111;

-- 2. Verify restore
SELECT COUNT(*) FROM data_agg_state;

-- 3. Revert function (from docs/temp/aggregatorsql lines 614-670)
-- Copy original function definition here if needed

COMMIT;
```

## Monitoring (24 hours)

Run daily:

```sql
-- Aggregation health
WITH daily_stats AS (
  SELECT 
    canonical_symbol,
    timeframe,
    total_runs,
    total_bars_created,
    last_successful_at_utc
  FROM data_agg_state
  WHERE timeframe IN ('5m', '1h')
)
SELECT 
  *,
  EXTRACT(EPOCH FROM (NOW() - last_successful_at_utc))/3600 AS hours_since_success
FROM daily_stats
ORDER BY hours_since_success DESC;
```

**Alert if**:
- hours_since_success > 2
- hard_fail_streak > 0
- No bars created in 4 hours

## Cleanup (48 hours after)

```sql
-- After verifying everything is stable
DROP TABLE IF EXISTS data_agg_state_backup_20260111;
```
