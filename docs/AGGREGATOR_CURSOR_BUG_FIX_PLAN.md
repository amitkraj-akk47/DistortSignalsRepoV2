# Aggregator Cursor Bug Fix - Implementation Plan

## Executive Summary

**Bug Confirmed**: The aggregator has a cursor management bug causing it to process empty windows indefinitely.

**Root Cause**: The `catchup_aggregation_range` function unconditionally advances the cursor even when no source data exists, leading to runaway cursor progression into future dates.

**Status**: ✅ **IMPLEMENTED** - Migration files created and ready for deployment

### Critical Fixes Applied (Production-Safe)

1. **EXIT Condition**: Changed from `stored=false` → `source_rows=0`
   - **Why**: `stored=false` includes idempotent cases (bar already exists), which would deadlock cursor
   - **Correct**: Only exit when window has zero source data (data frontier reached)

2. **Cursor Advancement**: Advance when `source_rows > 0` (not just when `stored=true`)
   - **Why**: Cursor tracks "windows processed" not "bars created"
   - **Handles**: Idempotent upserts, quality filter skips, partial data correctly

3. **DXY Cursor Reset**: Fixed to query `derived_data_bars` instead of `data_bars`
   - **Why**: DXY 1m candles are synthetic (derived from 6 pairs), not raw ingestion
   - **Added**: Verification check specifically for DXY cursor positioning

4. **Rationale Correction**: Changed from "gaps are rare in markets" → "detect data frontier in pipeline"
   - **Why**: System gaps (outages, rate limits) are common even in continuous markets
   - **Result**: More robust handling of real-world scenarios

## Diagnosis Confirmation

### ✅ Evidence from Code Review

1. **`agg_bootstrap_cursor` function** (lines 342-383 in aggregatorsql)
   - ✅ **CORRECT**: Uses `MAX(ts_utc)` from source data
   - ✅ **CORRECT**: Returns `boundary - interval` (one window back from latest data)
   - ✅ No bug here - bootstrap is properly implemented

2. **`catchup_aggregation_range` function** (lines 614-670 in aggregatorsql)
   - ❌ **BUG IDENTIFIED**: Line 658: `v_cursor := v_we;`
   - This line executes **unconditionally** inside the loop
   - Even when `aggregate_1m_to_5m_window` returns `stored=false` (no data), cursor still advances
   - No protection against advancing into empty time regions

3. **`aggregate_1m_to_5m_window` function** (lines 435-469)
   - Returns `stored=false` with reason 'insufficient_source_bars' when `v_cnt < 3`
   - This is correct behavior - the problem is the caller ignores it

### How the Bug Manifests

```
Iteration 1: cursor=2026-01-09 21:55, source_bars=5, stored=true  → cursor→22:00 ✓
Iteration 2: cursor=2026-01-09 22:00, source_bars=0, stored=false → cursor→22:05 ✗ BUG
Iteration 3: cursor=2026-01-09 22:05, source_bars=0, stored=false → cursor→22:10 ✗ BUG
...
Iteration N: cursor=2026-01-11 07:20, source_bars=0, stored=false → cursor→07:25 ✗ BUG
```

Worker logs show:
- `total_runs = 154` (many iterations)
- `total_bars_created = 2` (only initial bars with data)
- No errors (success=true every time)

## Implementation Plan

### Phase 1: SQL Function Fixes

#### Fix 1: `catchup_aggregation_range` - Stop cursor advancement on empty windows

**File**: `docs/temp/aggregatorsql` (will need to create proper migration)

**Change Location**: Lines 640-660

**Current Code**:
```sql
v_stored := coalesce((v_res->>'stored')::boolean,false);
if v_stored then
  v_created := v_created + 1;
  v_q := (v_res->>'quality_score')::int;
  if v_q <= 0 then v_poor := v_poor + 1; end if;
else
  v_skipped := v_skipped + 1;
end if;

v_cursor := v_we;  -- ❌ ALWAYS advances
v_processed := v_processed + 1;
```

**Fixed Code**:
```sql
v_stored := coalesce((v_res->>'stored')::boolean,false);
v_source_rows := coalesce((v_res->>'source_count')::int, 0);

-- EXIT only when source_rows = 0 (data frontier reached)
-- Do NOT exit just because stored=false (could be idempotent/quality skip)
if v_source_rows = 0 then
  v_skipped := v_skipped + 1;
  exit;  -- Stop at data frontier
end if;

-- Advance cursor whenever we processed a window with source data
-- regardless of whether we stored a bar (idempotent case)
if v_stored then
  v_created := v_created + 1;
  v_q := (v_res->>'quality_score')::int;
  if v_q <= 0 then v_poor := v_poor + 1; end if;
else
  v_skipped := v_skipped + 1;
end if;

v_cursor := v_we;  -- ✅ Advance cursor when source_rows > 0
v_processed := v_processed + 1;
```

**Rationale**:
- Advance cursor when a window has source data (regardless of whether a bar was stored)
- Exit loop immediately when hitting windows with zero source rows (data frontier)
- Prevents cursor from racing ahead of available data

**Why EXIT on source_rows=0 is correct** (not stored=false):
- `source_rows = 0` definitively indicates we've reached the data frontier (no more source data available)
- `stored = false` can mean many things: idempotent noop (bar already exists), quality filter skip, or no source data
- Exiting on `stored=false` would deadlock cursor on idempotent windows
- The distinction: "Did we find source data?" (advance) vs "Did we store a bar?" (metric only)

**Systems reality**:
- Even in continuous markets (forex/crypto), your *pipeline* has gaps due to: ingestion outages, rate limits, provider issues, cron failures
- The safety check at function entry prevents processing when cursor is already beyond source data
- This EXIT-on-zero-source pattern correctly detects the data frontier in all scenarios

**Cursor Semantics Clarification**:
- `last_agg_bar_ts_utc` represents the START timestamp of the last successfully processed window
- If cursor = `2026-01-09 21:50`, it means we completed processing the `21:50-21:55` window
- Next execution will process `21:55-22:00`, then `22:00-22:05`, etc.
- Bootstrap function returns `boundary_of_max_source - interval` to position cursor at the start of the second-to-last boundary

**Cursor Advancement Decision Matrix**:

| Scenario | source_rows | stored | Action | Rationale |
|----------|-------------|--------|--------|----------|
| Normal aggregation | 5 | true | Advance | Standard case |
| Idempotent (already exists) | 5 | false | Advance | Window was processed (upsert noop) |
| Quality filter skip | 3 | false | Advance | Insufficient quality but data exists |
| Data frontier reached | 0 | false | **EXIT** | No more source data available |
| Confirmation not ready | N/A | N/A | EXIT | Time-based stop (not bug-related) |

**Key principle**: Cursor advancement means "we handled this window" not "we created a bar"

#### Fix 2: Add safety check in `catchup_aggregation_range`

**Additional Safety**: Check if we're beyond available source data before processing

**Integrated into DECLARE section** (see Phase 2 migration - this adds `v_max_source_ts` and `v_src_tf` variables and performs the check early in the function body)

**Benefits**:
- Prevents processing when cursor is already beyond available source data
- Short-circuits the function immediately, avoiding unnecessary window iteration
- Returns descriptive reason for observability
- Works in tandem with the EXIT-on-skip logic to create defense-in-depth

### Phase 2: Create Migration File

**CRITICAL**: The window aggregation functions must return `source_count` in their JSONB result:

**Required changes to `aggregate_1m_to_5m_window` and `aggregate_5m_to_1h_window`**:

Currently returns:
```sql
return jsonb_build_object('success',true,'stored',true,'source_count',v_cnt,'quality_score',v_q);
-- or
return jsonb_build_object('success',true,'stored',false,'reason','insufficient_source_bars','source_count',v_cnt);
```

✅ **Already correct** - these functions already return `source_count` in all branches. Verify this before deploying.

**File**: `db/migrations/004_fix_aggregator_cursor.sql`

```sql
-- Fix aggregator cursor management bug
-- Prevents cursor from advancing beyond available source data

BEGIN;

-- Drop and recreate catchup_aggregation_range with fix
DROP FUNCTION IF EXISTS catchup_aggregation_range(text,text,timestamptz,integer,timestamptz,int,boolean);

CREATE OR REPLACE FUNCTION catchup_aggregation_range(
  p_symbol text,
  p_to_tf text,
  p_start_cursor_utc timestamptz,
  p_max_windows integer DEFAULT 100,
  p_now_utc timestamptz DEFAULT NULL,
  p_derivation_version int DEFAULT 1,
  p_ignore_confirmation boolean DEFAULT false
)
RETURNS jsonb 
LANGUAGE plpgsql 
SECURITY DEFINER 
SET search_path=public 
AS $$
DECLARE
  v_now timestamptz := coalesce(p_now_utc, now());
  v_interval_min int; 
  v_delay_sec int;
  v_cursor timestamptz := p_start_cursor_utc;
  v_ws timestamptz; 
  v_we timestamptz; 
  v_confirm timestamptz;
  v_processed int := 0; 
  v_created int := 0; 
  v_poor int := 0; 
  v_skipped int := 0;
  v_res jsonb; 
  v_stored boolean; 
  v_source_rows int;
  v_q int;
  v_max_source_ts timestamptz;
  v_src_tf text;
BEGIN
  SELECT run_interval_minutes, aggregation_delay_seconds, source_timeframe 
  INTO v_interval_min, v_delay_sec, v_src_tf
  FROM data_agg_state 
  WHERE canonical_symbol = p_symbol AND timeframe = p_to_tf;

  IF v_interval_min IS NULL THEN 
    RAISE EXCEPTION 'Missing agg config %/%', p_symbol, p_to_tf; 
  END IF;

  -- Safety check: get max available source timestamp
  SELECT max(ts_utc) INTO v_max_source_ts
  FROM (
    SELECT ts_utc FROM data_bars 
      WHERE canonical_symbol = p_symbol AND timeframe = v_src_tf
    UNION ALL
    SELECT ts_utc FROM derived_data_bars 
      WHERE canonical_symbol = p_symbol AND timeframe = v_src_tf AND deleted_at IS NULL
  ) x;
  
  -- If cursor is already beyond available data, return immediately
  IF v_max_source_ts IS NOT NULL AND v_cursor > v_max_source_ts THEN
    RETURN jsonb_build_object(
      'success', true,
      'windows_processed', 0,
      'cursor_advanced_to', v_cursor,
      'bars_created', 0,
      'bars_quality_poor', 0,
      'bars_skipped', 0,
      'continue', false,
      'reason', 'cursor_beyond_source_data'
    );
  END IF;

  WHILE v_processed < p_max_windows LOOP
    v_ws := v_cursor;
    v_we := v_ws + make_interval(mins => v_interval_min);
    v_confirm := v_we + make_interval(secs => v_delay_sec);

    IF (NOT p_ignore_confirmation) AND v_now < v_confirm THEN 
      EXIT; 
    END IF;

    IF p_to_tf = '5m' THEN
      v_res := aggregate_1m_to_5m_window(p_symbol, v_ws, v_we, p_derivation_version);
    ELSIF p_to_tf = '1h' THEN
      v_res := aggregate_5m_to_1h_window(p_symbol, v_ws, v_we, p_derivation_version);
    ELSE
      RAISE EXCEPTION 'Unsupported tf=%', p_to_tf;
    END IF;

    v_stored := coalesce((v_res->>'stored')::boolean, false);
    v_source_rows := coalesce((v_res->>'source_count')::int, 0);
    
    -- EXIT only when source_rows = 0 (data frontier)
    -- Do NOT exit merely because stored=false
    IF v_source_rows = 0 THEN
      v_skipped := v_skipped + 1;
      EXIT;  -- Stop at data frontier
    END IF;
    
    -- Process window stats
    IF v_stored THEN
      v_created := v_created + 1;
      v_q := (v_res->>'quality_score')::int;
      IF v_q <= 0 THEN 
        v_poor := v_poor + 1; 
      END IF;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;
    
    -- Advance cursor when we processed a window with source data
    v_cursor := v_we;
    v_processed := v_processed + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'windows_processed', v_processed,
    'cursor_advanced_to', v_cursor,
    'bars_created', v_created,
    'bars_quality_poor', v_poor,
    'bars_skipped', v_skipped,
    'continue', (v_processed = p_max_windows)
  );
END $$;

REVOKE EXECUTE ON FUNCTION catchup_aggregation_range(text,text,timestamptz,integer,timestamptz,int,boolean) FROM public;
GRANT EXECUTE ON FUNCTION catchup_aggregation_range(text,text,timestamptz,integer,timestamptz,int,boolean) TO service_role;

COMMIT;
```

### Phase 3: Reset Cursors to Valid Positions

**File**: `db/migrations/005_reset_aggregator_cursors.sql`

**Important**: This migration resets cursors to safe positions. The last complete window may be re-aggregated (via upsert), which is safe but may cause duplicate processing on first run after fix.

```sql
-- Reset aggregator cursors to valid positions based on available source data
-- This positions cursors at (max_boundary - interval), allowing the last complete
-- window to be re-aggregated safely via upsert
BEGIN;

-- For 5m aggregation (from 1m source)
-- Note: DXY 1m is in derived_data_bars, not data_bars
WITH max_1m AS (
  SELECT canonical_symbol, MAX(ts_utc) as max_ts
  FROM (
    SELECT canonical_symbol, ts_utc FROM data_bars WHERE timeframe='1m'
    UNION ALL
    SELECT canonical_symbol, ts_utc FROM derived_data_bars WHERE timeframe='1m' AND deleted_at IS NULL
  ) x
  GROUP BY canonical_symbol
)
UPDATE data_agg_state s
SET 
  last_agg_bar_ts_utc = (
    -- Floor to 5m boundary and subtract one interval
    to_timestamp(
      (floor(extract(epoch from m.max_ts) / 300) * 300 - 300)
    )
  ),
  status = 'idle',
  next_run_at = NOW(),
  last_error = 'cursor_reset_2026-01-11',
  updated_at = NOW()
FROM max_1m m
WHERE s.canonical_symbol = m.canonical_symbol
  AND s.timeframe = '5m'
  AND s.source_timeframe = '1m'
  AND (s.last_agg_bar_ts_utc > m.max_ts OR s.last_agg_bar_ts_utc IS NULL);

-- Verify DXY cursor was set correctly (DXY source is derived only)
DO $$
DECLARE
  v_dxy_cursor timestamptz;
  v_dxy_max_source timestamptz;
BEGIN
  SELECT last_agg_bar_ts_utc INTO v_dxy_cursor
  FROM data_agg_state
  WHERE canonical_symbol = 'DXY' AND timeframe = '5m';
  
  SELECT MAX(ts_utc) INTO v_dxy_max_source
  FROM derived_data_bars
  WHERE canonical_symbol = 'DXY' AND timeframe = '1m' AND deleted_at IS NULL;
  
  IF v_dxy_cursor IS NULL OR v_dxy_max_source IS NULL THEN
    RAISE WARNING 'DXY cursor reset check: cursor=%, max_source=%', v_dxy_cursor, v_dxy_max_source;
  ELSIF v_dxy_cursor > v_dxy_max_source THEN
    RAISE EXCEPTION 'DXY cursor still ahead of source after reset: cursor=%, max_source=%', v_dxy_cursor, v_dxy_max_source;
  END IF;
END $$;

-- For 1h aggregation (from 5m source)
WITH max_5m AS (
  SELECT canonical_symbol, MAX(ts_utc) as max_ts
  FROM derived_data_bars 
  WHERE timeframe='5m' AND deleted_at IS NULL
  GROUP BY canonical_symbol
)
UPDATE data_agg_state s
SET 
  last_agg_bar_ts_utc = (
    -- Floor to 1h boundary and subtract one interval
    to_timestamp(
      (floor(extract(epoch from m.max_ts) / 3600) * 3600 - 3600)
    )
  ),
  status = 'idle',
  next_run_at = NOW(),
  last_error = 'cursor_reset_2026-01-11',
  updated_at = NOW()
FROM max_5m m
WHERE s.canonical_symbol = m.canonical_symbol
  AND s.timeframe = '1h'
  AND s.source_timeframe = '5m'
  AND (s.last_agg_bar_ts_utc > m.max_ts OR s.last_agg_bar_ts_utc IS NULL);

COMMIT;
```

### Phase 4: Verification Queries

After deploying fixes, run these queries to verify:

#### 1. Verify cursors are within valid range
```sql
WITH latest AS (
  SELECT canonical_symbol, MAX(ts_utc) AS latest_1m
  FROM data_bars
  WHERE timeframe='1m'
  GROUP BY canonical_symbol
)
SELECT
  s.canonical_symbol,
  s.timeframe,
  s.last_agg_bar_ts_utc,
  l.latest_1m,
  (s.last_agg_bar_ts_utc > l.latest_1m) AS cursor_is_ahead_of_source
FROM data_agg_state s
JOIN latest l USING (canonical_symbol)
WHERE s.timeframe='5m'
ORDER BY s.canonical_symbol;
```

**Expected**: All `cursor_is_ahead_of_source` should be `false`

#### 2. Verify next window has data
```sql
SELECT 
  canonical_symbol,
  timeframe,
  last_agg_bar_ts_utc,
  last_agg_bar_ts_utc + make_interval(mins => run_interval_minutes) as next_window_end,
  (
    SELECT COUNT(*) 
    FROM data_bars db 
    WHERE db.canonical_symbol = s.canonical_symbol 
      AND db.timeframe = s.source_timeframe
      AND db.ts_utc >= s.last_agg_bar_ts_utc
      AND db.ts_utc < s.last_agg_bar_ts_utc + make_interval(mins => run_interval_minutes)
  ) as source_bars_in_next_window
FROM data_agg_state s
WHERE timeframe IN ('5m', '1h')
ORDER BY canonical_symbol, timeframe;
```

**Expected**: `source_bars_in_next_window` should be > 0 for all rows

#### 3. Monitor aggregation progress
```sql
SELECT 
  canonical_symbol,
  timeframe,
  total_runs,
  total_bars_created,
  total_bars_quality_poor,
  last_successful_at_utc,
  last_error,
  status
FROM data_agg_state
WHERE timeframe IN ('5m', '1h')
ORDER BY canonical_symbol, timeframe;
```

#### Pre-Deployment Verification

**Run these queries BEFORE deploying to confirm the bug exists**:

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
-- Expect: gap > 0 (cursor ahead), low bars_per_run
anually test the function** (optional but recommended)
   ```sql
   -- Test with one symbol before waiting for cron
   SELECT catchup_aggregation_range(
     'EURUSD',
     '5m',
     (SELECT last_agg_bar_ts_utc FROM data_agg_state 
      WHERE canonical_symbol='EURUSD' AND timeframe='5m'),
     5,  -- Small window count for testing
     NOW(),
     1,
     true
   );
   -- Should see bars_created > 0 and cursor advancing reasonably
   ```

7. **Monitor next cron run** (watch for bars_created increasing)
   ```bash
   # Tail aggregator logs
   cd /workspaces/DistortSignalsRepoV2/apps/typescript/aggregator
   pnpm tail:dev
   
   # Watch for log entries showing bars being created
   ```

8. **Verify ongoing health** (run 1 hour after deployment)
   ```sql
   SELECT 
     canonical_symbol,
     timeframe,
     total_runs,
     total_bars_created,
     last_successful_at_utc,
     EXTRACT(EPOCH FROM (NOW() - last_successful_at_utc))/60 AS minutes_since_success
   FROM data_agg_state
   WHERE timeframe IN ('5m', '1h')
   ORDER BY canonical_symbol, timeframe;
   -- All should have recent last_successful_at_utc
   ```

9ELECT 
  canonical_symbol,
  timeframe,
  total_runs,
  total_bars_created,
  hard_fail_streak,
  last_error,
  status
FROM data_agg_state
WHERE timeframe IN ('5m', '1h')
  AND total_runs > 50
  AND total_bars_created < 10
ORDER BY total_runs DESC;
-- Expect: high runs, low bars_created, no errors
```

#### Deployment

1. **Backup current state**
   ```sql
   CREATE TABLE data_agg_state_backup_20260111 AS 
   SELECT * FROM data_agg_state;
   
   -- Verify backup
   SELECT COUNT(*) FROM data_agg_state_backup_20260111
1. **Backup current state**
   ```sql
   CREATE TABLE data_agg_state_backup_20260111 AS 
   SELECT * FROM data_agg_state;
   ```

2. **Deploy migration 004** (fix function)
   ```bash
   cd /workspaces/DistortSignalsRepoV2
   psql $DATABASE_URL < db/migrations/004_fix_aggregator_cursor.sql
   ```

3. **Verify functio-MEDIUM
- ✅ Change is localized to one function
- ✅ No schema changes (only data updates)
- ✅ Easy rollback via backup
- ✅ Testable in isolation
- ⚠️ Cursor reset may cause one-time re-aggregation of last complete window (safe due to upsert)
- ⚠️ If fix is incorrect, could prevent aggregation from running at all

**Impact**: HIGH
- ✅ Fixes critical operational bug
- ✅ Enables proper aggregation to resume
- ✅ Prevents wasted compute cycles (currently running 150+ no-op iterations per task)
- ✅ Restores data pipeline health
 & migration creation): 30 minutes
- **Phase 3** (Cursor reset migration): 15 minutes
- **Phase 4** (Pre-deployment verification): 15 minutes
- **Phase 5** (Deployment & testing): 45 minutes
  - Backup: 5 minutes
  - Deploy migration 004: 5 minutes
  - Verify function: 5 minutes
  - Deploy migration 005: 5 minutes
  - Manual testing: 10 minutes
  - Verification queries: 10 minutes
  - Wait for cron + monitor: 5 minutes
- **Post-deployment monitoring**: 2-4 hours active, 24 hours passive

**Total Hands-On Time**: ~2 hours
**Total Timeline**: 2 hours + 24h monitoring

## Production Readiness Checklist

Before deploying, confirm the plan explicitly answers:

- [x] **What condition triggers EXIT?**
  - ✅ `source_rows = 0` (not `stored=false`)
  - ✅ Exiting on `stored=false` would deadlock on idempotent windows

- [x] **What if bar already exists (idempotent noop)?**
  - ✅ Cursor advances (window was processed, upsert returned false)
  - ✅ `v_skipped` increments but cursor moves forward

- [x] **What about DXY cursor reset?**
  - ✅ Uses `derived_data_bars`, not `data_bars` (DXY 1m is synthetic)
  - ✅ Includes verification check for DXY specifically

- [x] **Do window functions return source_count?**
  - ✅ Both `aggregate_1m_to_5m_window` and `aggregate_5m_to_1h_window` return `source_count` in all branches
  - ⚠️ Verify in production DB before deploying

- [x] **What if ingestion is behind by 2 days?**
  - ✅ Aggregation stops at data frontier (cursor doesn't advance)
  - ✅ Fix ingestion separately; aggregation will resume automatically when data arrives
  - ✅ Safety check returns early if cursor already beyond source data

## Future Enhancements

While the current fix is appropriate for the data frontier detection scenario, future improvements could include:

1. **Configurable skip tolerance**:
   ```sql
   -- Allow N consecutive skipped windows before exiting
   v_consecutive_skips int := 0;
   v_max_consecutive_skips int := 3;  -- configurable per timeframe
   ```

2. **Gap detection and alerting**:
   - Log when windows are skipped
   - Alert if unusual gap patterns detected
   - Track gap statistics in `data_agg_state`

3. **Backfill mode**:
   - Add `p_backfill_mode` parameter that continues through gaps
   - Useful for historical data restoration after outages

4. **Better observability**:
   - Return list of skipped windows with reasons
   - Track "skipped due to gaps" vs "skipped due to insufficient bars"
   - Add metrics table for aggregation performance

5. **Dynamic confirmation delays**:
   - Adjust `aggregation_delay_seconds` based on observed data arrival patterns
   - Reduce delays during historical backfills
   - Increase during real-time processing

## Monitoring Recommendations

After deployment, monitor these metrics:

```sql
-- Daily aggregation health check
WITH daily_stats AS (
  SELECT 
    canonical_symbol,
    timeframe,
    total_runs,
    total_bars_created,
    LAG(total_bars_created) OVER (PARTITION BY canonical_symbol, timeframe ORDER BY updated_at) AS prev_bars,
    updated_at
  FROM data_agg_state
  WHERE timeframe IN ('5m', '1h')
)
SELECT 
  canonical_symbol,
  timeframe,
  total_bars_created - COALESCE(prev_bars, 0) AS bars_created_today,
  total_runs
FROM daily_stats
WHERE updated_at >= NOW() - INTERVAL '24 hours'
ORDER BY bars_created_today DESC;
```

**Alert Conditions**:
- `bars_created_today = 0` for > 2 hours → aggregation stalled
- `hard_fail_streak > 0` → persistent errors
- `cursor > max_source_ts + 1 day` → cursor runaway (bug regression)
- `bars_created_today < expected_bars * 0.8` → data quality issuek on edge cases)

5. **Run verification queries** (from Phase 4)

6. **Monitor next cron run** (watch for bars_created increasing)

7. **Clean up backup** (after 24-48 hours of successful operation)
   ```sql
   DROP TABLE IF EXISTS data_agg_state_backup_20260111;
   ```

## Testing Strategy

### Unit Test: catchup_aggregation_range

```sql
-- Test 1: Should stop when hitting empty windows
SELECT catchup_aggregation_range(
  'EURUSD',
  '5m',
  '2026-01-09 21:50:00+00',  -- cursor at end of data
  100,
  NOW(),
  1,
  true  -- ignore confirmation
);
-- Expected: windows_processed < 100, reason='cursor_beyond_source_data' or stopped early

-- Test 2: Should process available windows only
SELECT catchup_aggregation_range(
  'EURUSD',
  '5m',
  '2026-01-09 20:00:00+00',  -- cursor in middle of data
  100,
  NOW(),
  1,
  true
);
-- Expected: windows_processed matches available windows, cursor stops at data boundary
```

### Integration Test: Full Aggregation Cycle

1. Reset one symbol to known state
2. Trigger aggregation via worker
3. Verify cursor advancement matches bars created
4. Verify no advancement beyond available data

## Rollback Plan

If issues arise:

```sql
BEGIN;

-- Restore from backup
DELETE FROM data_agg_state;
INSERT INTO data_agg_state SELECT * FROM data_agg_state_backup_20260111;

-- Revert function (restore original from docs/temp/aggregatorsql)
-- [Include original function definition]

COMMIT;
```

## Success Criteria

✅ **Fix is successful when**:
1. All cursors are <= max available source timestamp
2. `total_runs` increases only when data is available
3. `total_bars_created` increases proportionally to runs
4. No "runaway cursor" into future dates
5. `hard_fail_streak` remains 0
6. Worker logs show meaningful work (not no-ops)

## Risk Assessment

**Risk Level**: LOW
- Change is localized to one function
- No schema changes
- Easy rollback
- Testable in isolation

**Impact**: HIGH
- Fixes critical operational bug
- Enables proper aggregation to resume
- Prevents wasted compute cycles

## Timeline

- **Phase 1-2** (SQL fixes): 1 hour
- **Phase 3** (Migration creation): 30 minutes  
- **Phase 4** (Testing): 1 hour
- **Phase 5** (Deployment): 30 minutes
- **Monitoring**: 24 hours

**Total**: ~3 hours hands-on + 24h monitoring
