# DXY Migration Phase 5 - Complete Aggregation Redesign

**Date**: 2026-01-13  
**Status**: Implementation Planning  
**Scope**: Comprehensive aggregation system redesign based on Option 3 + mandatory timeframes + registry-driven config

---

## Executive Summary

### What's Changing

1. **DXY Architecture (Option 3 - COMPLETED Phase 1-4)**
   - ✅ DXY 1m moved from `derived_data_bars` → `data_bars`
   - ⚠️ Aggregation functions still use UNION ALL (Phase 5)
   
2. **Mandatory Timeframes (NEW)**
   - Every asset MUST have 5m and 1h aggregated timeframes
   - Standardized start date: **2025-07-01 00:00:00+00** for all assets
   
3. **Registry-Driven Configuration (NEW)**
   - `core_asset_registry_all.metadata` defines which timeframes to build
   - `data_agg_state` auto-synced from registry
   - Eliminates manual task management

### Migration Philosophy

**Before**: Ad-hoc task creation, DXY special-cased, UNION ALL for 1m sources  
**After**: Registry-driven, uniform processing, single-table queries, mandatory coverage

---

## Part 1: Database Schema Changes

### 1.1 Extend `data_agg_state` Table

**Current Schema** (from aggregatorsql):
```sql
CREATE TABLE data_agg_state (
  canonical_symbol text NOT NULL,
  timeframe text NOT NULL,
  source_timeframe text,
  
  run_interval_minutes integer,
  aggregation_delay_seconds integer,
  
  last_agg_bar_ts_utc timestamptz,
  status text DEFAULT 'idle',  -- idle|running|disabled|hard_failed
  next_run_at timestamptz,
  running_started_at_utc timestamptz,
  
  is_mandatory boolean NOT NULL DEFAULT false,
  hard_fail_streak integer DEFAULT 0,
  
  total_runs bigint DEFAULT 0,
  total_bars_created bigint DEFAULT 0,
  total_bars_quality_poor bigint DEFAULT 0,
  
  last_successful_at_utc timestamptz,
  last_attempted_at_utc timestamptz,
  last_error text,
  
  updated_at timestamptz,
  
  PRIMARY KEY (canonical_symbol, timeframe)
);
```

**Add New Columns**:
```sql
ALTER TABLE data_agg_state
  ADD COLUMN IF NOT EXISTS agg_start_utc timestamptz 
    NOT NULL DEFAULT '2025-07-01 00:00:00+00',
  ADD COLUMN IF NOT EXISTS enabled boolean 
    NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS task_priority integer 
    NOT NULL DEFAULT 100;

-- Add index for priority-based task selection
CREATE INDEX IF NOT EXISTS idx_agg_state_priority
  ON data_agg_state (is_mandatory DESC, timeframe ASC, task_priority ASC, last_successful_at_utc ASC NULLS FIRST)
  WHERE status = 'idle' AND enabled = true;

COMMENT ON COLUMN data_agg_state.agg_start_utc IS 
  'First timestamp to start aggregation. Nothing will be aggregated before this date.';
COMMENT ON COLUMN data_agg_state.enabled IS 
  'Whether this task is active. Disabled tasks are skipped completely.';
COMMENT ON COLUMN data_agg_state.task_priority IS 
  'Lower = higher priority. Used as tie-breaker after mandatory/timeframe sorting.';
```

### 1.2 Create Registry Sync Function

```sql
CREATE OR REPLACE FUNCTION sync_agg_state_from_registry(
  p_env text DEFAULT 'prod',
  p_default_start_utc timestamptz DEFAULT '2025-07-01 00:00:00+00'
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_inserted integer := 0;
  v_updated integer := 0;
  v_disabled integer := 0;
  v_rec record;
BEGIN
  -- 1) Ensure all active assets have mandatory 5m and 1h tasks
  WITH active_assets AS (
    SELECT canonical_symbol
    FROM core_asset_registry_all
    WHERE is_active = true
  ),
  mandatory_tasks AS (
    SELECT 
      canonical_symbol,
      unnest(ARRAY['5m', '1h']) AS timeframe,
      CASE 
        WHEN unnest(ARRAY['5m', '1h']) = '5m' THEN '1m'
        WHEN unnest(ARRAY['5m', '1h']) = '1h' THEN '5m'
      END AS source_timeframe,
      CASE 
        WHEN unnest(ARRAY['5m', '1h']) = '5m' THEN 5
        WHEN unnest(ARRAY['5m', '1h']) = '1h' THEN 60
      END AS run_interval_minutes,
      300 AS aggregation_delay_seconds,  -- 5 min standard delay
      true AS is_mandatory,
      true AS enabled,
      100 AS task_priority
    FROM active_assets
  )
  INSERT INTO data_agg_state (
    canonical_symbol,
    timeframe,
    source_timeframe,
    run_interval_minutes,
    aggregation_delay_seconds,
    is_mandatory,
    enabled,
    task_priority,
    agg_start_utc,
    status,
    next_run_at
  )
  SELECT 
    canonical_symbol,
    timeframe,
    source_timeframe,
    run_interval_minutes,
    aggregation_delay_seconds,
    is_mandatory,
    enabled,
    task_priority,
    p_default_start_utc,
    'idle',
    NOW()
  FROM mandatory_tasks
  ON CONFLICT (canonical_symbol, timeframe) DO UPDATE SET
    is_mandatory = EXCLUDED.is_mandatory,
    enabled = EXCLUDED.enabled,
    task_priority = EXCLUDED.task_priority,
    source_timeframe = EXCLUDED.source_timeframe,
    run_interval_minutes = EXCLUDED.run_interval_minutes,
    aggregation_delay_seconds = EXCLUDED.aggregation_delay_seconds,
    -- Preserve cursor and status, just update config
    updated_at = NOW();
  
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  
  -- 2) Disable tasks for assets that are no longer active
  WITH active_symbols AS (
    SELECT canonical_symbol FROM core_asset_registry_all WHERE is_active = true
  )
  UPDATE data_agg_state
  SET 
    enabled = false,
    status = 'disabled',
    updated_at = NOW()
  WHERE canonical_symbol NOT IN (SELECT canonical_symbol FROM active_symbols)
    AND enabled = true;
  
  GET DIAGNOSTICS v_disabled = ROW_COUNT;
  
  RETURN jsonb_build_object(
    'success', true,
    'inserted_or_updated', v_inserted,
    'disabled', v_disabled,
    'default_start_utc', p_default_start_utc
  );
END;
$$;

COMMENT ON FUNCTION sync_agg_state_from_registry IS
  'Syncs data_agg_state with core_asset_registry_all. Creates/updates mandatory 5m+1h tasks for all active assets.';
```

### 1.3 Update Cursor Bootstrap Function

```sql
CREATE OR REPLACE FUNCTION agg_bootstrap_cursor(
  p_symbol text,
  p_to_tf text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_start_utc timestamptz;
  v_interval_sec integer;
  v_bootstrap_cursor timestamptz;
BEGIN
  -- Get configured start date and interval
  SELECT 
    agg_start_utc,
    run_interval_minutes * 60
  INTO v_start_utc, v_interval_sec
  FROM data_agg_state
  WHERE canonical_symbol = p_symbol AND timeframe = p_to_tf;
  
  IF v_start_utc IS NULL THEN
    RAISE EXCEPTION 'No agg config found for %/%', p_symbol, p_to_tf;
  END IF;
  
  -- Bootstrap cursor = start_date - interval
  -- This positions cursor so first window starts exactly at agg_start_utc
  v_bootstrap_cursor := v_start_utc - (v_interval_sec || ' seconds')::interval;
  
  UPDATE data_agg_state
  SET 
    last_agg_bar_ts_utc = v_bootstrap_cursor,
    status = 'idle',
    next_run_at = NOW(),
    updated_at = NOW()
  WHERE canonical_symbol = p_symbol AND timeframe = p_to_tf;
  
  RETURN jsonb_build_object(
    'success', true,
    'bootstrapped_cursor', v_bootstrap_cursor,
    'will_start_at', v_start_utc
  );
END;
$$;

COMMENT ON FUNCTION agg_bootstrap_cursor IS
  'Initializes cursor for a task using agg_start_utc. Cursor = start_date - interval.';
```

---

## Part 2: Aggregation Function Updates

### 2.1 Update `aggregate_1m_to_5m_window()` - Remove UNION ALL

**Current Code** (lines 430-470 in aggregatorsql):
```sql
WITH src AS (
  SELECT ... FROM data_bars WHERE timeframe='1m' ...
  UNION ALL
  SELECT ... FROM derived_data_bars WHERE timeframe='1m' ...  -- ❌ REMOVE
)
```

**Updated Code**:
```sql
CREATE OR REPLACE FUNCTION aggregate_1m_to_5m_window(
  p_symbol text,
  p_from_utc timestamptz,
  p_to_utc timestamptz,
  p_derivation_version int DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_cnt int;
  v_o double precision; v_h double precision; v_l double precision; v_c double precision;
  v_vol double precision; v_vwap double precision; v_tc bigint;
  v_q int;
BEGIN
  -- ✅ SINGLE TABLE QUERY - All 1m data (including DXY) now in data_bars
  WITH src AS (
    SELECT ts_utc, open, high, low, close, vol, vwap, trade_count
    FROM data_bars
    WHERE canonical_symbol = p_symbol 
      AND timeframe = '1m'
      AND ts_utc >= p_from_utc 
      AND ts_utc < p_to_utc
  ),
  agg AS (
    SELECT 
      COUNT(*) AS cnt,
      (array_agg(open ORDER BY ts_utc))[1] AS first_open,
      MAX(high) AS max_high,
      MIN(low) AS min_low,
      (array_agg(close ORDER BY ts_utc DESC))[1] AS last_close,
      SUM(vol) AS sum_vol,
      CASE 
        WHEN SUM(vol) > 0 THEN SUM(vwap * vol) / SUM(vol)
        ELSE NULL
      END AS weighted_vwap,
      SUM(trade_count) AS sum_tc
    FROM src
  )
  SELECT cnt, first_open, max_high, min_low, last_close, sum_vol, weighted_vwap, sum_tc
  INTO v_cnt, v_o, v_h, v_l, v_c, v_vol, v_vwap, v_tc
  FROM agg;

  -- Quality scoring: 5 bars = excellent, 4 = good, 3 = poor, <3 = skip
  IF v_cnt IS NULL OR v_cnt = 0 THEN
    RETURN jsonb_build_object(
      'success', true,
      'stored', false,
      'source_count', 0,
      'reason', 'insufficient_source_bars'
    );
  END IF;

  IF v_cnt >= 5 THEN v_q := 2;      -- Excellent
  ELSIF v_cnt = 4 THEN v_q := 1;    -- Good
  ELSIF v_cnt = 3 THEN v_q := 0;    -- Poor
  ELSE
    RETURN jsonb_build_object(
      'success', true,
      'stored', false,
      'source_count', v_cnt,
      'reason', 'insufficient_source_bars'
    );
  END IF;

  -- Upsert to derived_data_bars
  PERFORM _upsert_derived_bar(
    p_symbol,
    '5m',
    p_from_utc,
    v_o, v_h, v_l, v_c,
    v_vol, v_vwap, v_tc,
    '1m',
    v_cnt,
    5,  -- expected
    v_q,
    p_derivation_version
  );

  RETURN jsonb_build_object(
    'success', true,
    'stored', true,
    'source_count', v_cnt,
    'quality_score', v_q
  );
END;
$$;

COMMENT ON FUNCTION aggregate_1m_to_5m_window IS
  'Aggregates 1m bars from data_bars to 5m in derived_data_bars. Single table query.';
```

### 2.2 Update `catchup_aggregation_range()` - Conditional Source Query + Start Date Guard

**Current Issues**:
- Uses UNION ALL for max source timestamp check
- No enforcement of `agg_start_utc`

**Updated Code**:
```sql
CREATE OR REPLACE FUNCTION catchup_aggregation_range(
  p_symbol text,
  p_to_tf text,
  p_start_cursor_utc timestamptz,
  p_max_windows integer DEFAULT 100,
  p_until_utc timestamptz DEFAULT NOW(),
  p_derivation_version integer DEFAULT 1,
  p_stop_on_zero_source boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_interval_min integer;
  v_delay_sec integer;
  v_src_tf text;
  v_agg_start_utc timestamptz;
  
  v_cursor timestamptz;
  v_max_source_ts timestamptz;
  v_frontier_utc timestamptz;
  
  v_ws timestamptz; v_we timestamptz;
  v_res jsonb;
  v_source_rows integer;
  v_stored boolean;
  
  v_processed integer := 0;
  v_total_bars integer := 0;
  v_poor_bars integer := 0;
  v_stopped_reason text := 'max_windows';
BEGIN
  -- Get config
  SELECT 
    run_interval_minutes, 
    aggregation_delay_seconds, 
    source_timeframe,
    agg_start_utc
  INTO v_interval_min, v_delay_sec, v_src_tf, v_agg_start_utc
  FROM data_agg_state 
  WHERE canonical_symbol = p_symbol AND timeframe = p_to_tf;

  IF v_interval_min IS NULL THEN 
    RAISE EXCEPTION 'Missing agg config for %/%', p_symbol, p_to_tf;
  END IF;

  -- Initialize cursor - enforce agg_start_utc minimum
  v_cursor := GREATEST(p_start_cursor_utc, v_agg_start_utc - (v_interval_min || ' minutes')::interval);
  
  -- Calculate frontier (don't aggregate incomplete windows)
  v_frontier_utc := p_until_utc - (v_delay_sec || ' seconds')::interval;

  -- ✅ Get max available source timestamp - CONDITIONAL UNION
  IF v_src_tf = '1m' THEN
    -- For 1m source: only query data_bars (DXY now included)
    SELECT MAX(ts_utc) INTO v_max_source_ts
    FROM data_bars
    WHERE canonical_symbol = p_symbol AND timeframe = v_src_tf;
  ELSE
    -- For 5m+ source: check both tables (future-proofing)
    SELECT MAX(ts_utc) INTO v_max_source_ts
    FROM (
      SELECT ts_utc FROM data_bars 
        WHERE canonical_symbol = p_symbol AND timeframe = v_src_tf
      UNION ALL
      SELECT ts_utc FROM derived_data_bars 
        WHERE canonical_symbol = p_symbol AND timeframe = v_src_tf AND deleted_at IS NULL
    ) x;
  END IF;

  -- Safety: if cursor already beyond available data, return early
  IF v_max_source_ts IS NOT NULL AND v_cursor >= v_max_source_ts THEN
    RETURN jsonb_build_object(
      'success', true,
      'windows_processed', 0,
      'bars_created', 0,
      'stopped_reason', 'cursor_at_frontier',
      'cursor_position', v_cursor,
      'max_source_ts', v_max_source_ts
    );
  END IF;

  -- Process windows
  WHILE v_processed < p_max_windows LOOP
    -- Calculate window bounds
    v_ws := v_cursor + (v_interval_min || ' minutes')::interval;
    v_we := v_ws + (v_interval_min || ' minutes')::interval;

    -- ✅ CRITICAL: Don't aggregate before agg_start_utc
    IF v_ws < v_agg_start_utc THEN
      v_cursor := v_we;
      v_processed := v_processed + 1;
      CONTINUE;  -- Skip this window
    END IF;

    -- Stop if we've reached the frontier
    IF v_we > v_frontier_utc THEN
      v_stopped_reason := 'frontier';
      EXIT;
    END IF;

    -- Call appropriate aggregation function
    IF p_to_tf = '5m' THEN
      v_res := aggregate_1m_to_5m_window(p_symbol, v_ws, v_we, p_derivation_version);
    ELSIF p_to_tf = '1h' THEN
      v_res := aggregate_5m_to_1h_window(p_symbol, v_ws, v_we, p_derivation_version);
    ELSE
      RAISE EXCEPTION 'Unsupported target timeframe: %', p_to_tf;
    END IF;

    -- Check result
    v_source_rows := COALESCE((v_res->>'source_count')::int, 0);
    v_stored := COALESCE((v_res->>'stored')::boolean, false);

    -- ✅ CRITICAL: Stop if no source data (reached data frontier)
    IF p_stop_on_zero_source AND v_source_rows = 0 THEN
      v_stopped_reason := 'no_source_data';
      EXIT;
    END IF;

    -- Track stats
    IF v_stored THEN
      v_total_bars := v_total_bars + 1;
      IF (v_res->>'quality_score')::int = 0 THEN
        v_poor_bars := v_poor_bars + 1;
      END IF;
    END IF;

    -- Advance cursor
    v_cursor := v_we;
    v_processed := v_processed + 1;
  END LOOP;

  -- Return summary
  RETURN jsonb_build_object(
    'success', true,
    'windows_processed', v_processed,
    'bars_created', v_total_bars,
    'bars_quality_poor', v_poor_bars,
    'new_cursor', v_cursor,
    'stopped_reason', v_stopped_reason,
    'agg_start_enforced', v_agg_start_utc
  );
END;
$$;

COMMENT ON FUNCTION catchup_aggregation_range IS
  'Processes multiple aggregation windows. Enforces agg_start_utc and uses conditional source queries.';
```

### 2.3 Update Task Selection Function - Mandatory First

```sql
CREATE OR REPLACE FUNCTION agg_get_due_tasks(
  p_env_name text DEFAULT 'prod',
  p_limit integer DEFAULT 10
)
RETURNS TABLE (
  canonical_symbol text,
  timeframe text,
  source_timeframe text,
  last_agg_bar_ts_utc timestamptz,
  run_interval_minutes integer,
  aggregation_delay_seconds integer,
  is_mandatory boolean,
  task_priority integer
)
LANGUAGE sql
AS $$
  SELECT 
    canonical_symbol,
    timeframe,
    source_timeframe,
    last_agg_bar_ts_utc,
    run_interval_minutes,
    aggregation_delay_seconds,
    is_mandatory,
    task_priority
  FROM data_agg_state
  WHERE status = 'idle'
    AND enabled = true
    AND next_run_at <= NOW()
  ORDER BY 
    is_mandatory DESC,        -- Mandatory tasks first
    timeframe ASC,            -- 5m before 1h
    task_priority ASC,        -- Lower priority number = higher priority
    last_successful_at_utc ASC NULLS FIRST  -- Never-run tasks first
  LIMIT p_limit;
$$;

COMMENT ON FUNCTION agg_get_due_tasks IS
  'Returns tasks ready to run. Orders: mandatory first, then 5m before 1h, then by priority.';
```

---

## Part 3: Worker Code Changes

### 3.1 Startup Sync (aggworker.ts)

**Add to worker initialization**:
```typescript
// At worker startup or on first cron run
async function ensureAggregationConfigSynced(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc('sync_agg_state_from_registry', {
    p_env: ENV_NAME,
    p_default_start_utc: '2025-07-01T00:00:00Z'
  });
  
  if (error) {
    console.error('Failed to sync agg state from registry:', error);
    throw error;
  }
  
  console.log('Agg state synced:', data);
  return data;
}

// Call once at worker init or before first task run
export default {
  async scheduled(event, env, ctx) {
    // Sync config on first run (idempotent)
    await ensureAggregationConfigSynced(supabase);
    
    // Then run aggregation tasks
    await runAggregation(env, ctx);
  }
}
```

### 3.2 Mandatory Task Failure Handling

**Update error handling**:
```typescript
async function finishTask(
  supabase: SupabaseClient,
  symbol: string,
  timeframe: string,
  success: boolean,
  stats: any,
  error: any,
  isMandatory: boolean
) {
  const isTransient = error && isTransientError(error);
  
  const { error: finishError } = await supabase.rpc('agg_finish', {
    p_symbol: symbol,
    p_tf: timeframe,
    p_success: success,
    p_new_cursor_utc: success ? stats.new_cursor : null,
    p_stats: success ? stats : null,
    p_fail_kind: !success ? (isTransient ? 'transient' : 'hard') : null,
    p_error: !success ? String(error?.message ?? error) : null
  });
  
  // ⚠️ Alert on mandatory task failures
  if (!success && isMandatory) {
    console.error(`🚨 MANDATORY TASK FAILED: ${symbol}/${timeframe}`, error);
    // TODO: Send to monitoring/alerting system
  }
}
```

---

## Part 4: Registry Metadata Schema (Optional Enhancement)

### 4.1 Add Aggregation Metadata to Registry

**If you want to support optional timeframes** (15m, 4h, 1d), add to `core_asset_registry_all.metadata`:

```json
{
  "agg": {
    "enabled": true,
    "start_utc": "2025-07-01T00:00:00Z",
    "mandatory": ["5m", "1h"],
    "optional": ["15m", "4h", "1d"]
  }
}
```

**Then update sync function**:
```sql
-- Extended version that reads metadata.agg
-- (Omitted for brevity - can add if requested)
```

---

## Part 5: Migration SQL

### File: `db/migrations/011_aggregation_redesign.sql`

```sql
-- ============================================================================
-- DXY Migration Phase 5 + Aggregation Redesign
-- ============================================================================
-- Changes:
-- 1. Remove UNION ALL from 1m aggregation (DXY now in data_bars)
-- 2. Add agg_start_utc to enforce unified start date
-- 3. Create registry sync function for automatic task management
-- 4. Update task selection to prioritize mandatory tasks
-- ============================================================================

BEGIN;

-- ============================================================================
-- PART 1: Schema Extensions
-- ============================================================================

-- Add new columns to data_agg_state
ALTER TABLE data_agg_state
  ADD COLUMN IF NOT EXISTS agg_start_utc timestamptz 
    NOT NULL DEFAULT '2025-07-01 00:00:00+00',
  ADD COLUMN IF NOT EXISTS enabled boolean 
    NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS task_priority integer 
    NOT NULL DEFAULT 100;

-- Update existing rows to have the default start date
UPDATE data_agg_state 
SET agg_start_utc = '2025-07-01 00:00:00+00'
WHERE agg_start_utc IS DISTINCT FROM '2025-07-01 00:00:00+00';

-- Add index for priority-based selection
CREATE INDEX IF NOT EXISTS idx_agg_state_priority
  ON data_agg_state (
    is_mandatory DESC, 
    timeframe ASC, 
    task_priority ASC, 
    last_successful_at_utc ASC NULLS FIRST
  )
  WHERE status = 'idle' AND enabled = true;

COMMENT ON COLUMN data_agg_state.agg_start_utc IS 
  'First timestamp to start aggregation. Nothing will be aggregated before this date.';
COMMENT ON COLUMN data_agg_state.enabled IS 
  'Whether this task is active. Disabled tasks are skipped completely.';
COMMENT ON COLUMN data_agg_state.task_priority IS 
  'Lower = higher priority. Tie-breaker after mandatory/timeframe sorting.';

-- ============================================================================
-- PART 2: Function Updates
-- ============================================================================

-- [Insert aggregate_1m_to_5m_window() from section 2.1]
-- [Insert catchup_aggregation_range() from section 2.2]
-- [Insert agg_get_due_tasks() from section 2.3]
-- [Insert agg_bootstrap_cursor() from section 1.3]
-- [Insert sync_agg_state_from_registry() from section 1.2]

-- ============================================================================
-- PART 3: Data Migration
-- ============================================================================

-- Sync tasks from registry (creates mandatory 5m+1h for all active assets)
SELECT sync_agg_state_from_registry('prod', '2025-07-01 00:00:00+00');

-- Reset cursors for tasks with NULL or invalid cursors
UPDATE data_agg_state
SET 
  last_agg_bar_ts_utc = agg_start_utc - (run_interval_minutes || ' minutes')::interval,
  status = 'idle',
  next_run_at = NOW(),
  updated_at = NOW()
WHERE last_agg_bar_ts_utc IS NULL
   OR last_agg_bar_ts_utc < agg_start_utc - (run_interval_minutes || ' minutes')::interval;

-- Mark all mandatory tasks for both 5m and 1h
UPDATE data_agg_state
SET is_mandatory = true
WHERE timeframe IN ('5m', '1h');

COMMIT;

-- ============================================================================
-- PART 4: Verification
-- ============================================================================

-- Check that all active assets have 5m and 1h tasks
SELECT 
  a.canonical_symbol,
  COUNT(CASE WHEN s.timeframe = '5m' THEN 1 END) AS has_5m,
  COUNT(CASE WHEN s.timeframe = '1h' THEN 1 END) AS has_1h
FROM core_asset_registry_all a
LEFT JOIN data_agg_state s USING (canonical_symbol)
WHERE a.is_active = true
GROUP BY a.canonical_symbol
HAVING COUNT(CASE WHEN s.timeframe = '5m' THEN 1 END) = 0
    OR COUNT(CASE WHEN s.timeframe = '1h' THEN 1 END) = 0;
-- Should return 0 rows

-- Check cursor positions
SELECT 
  canonical_symbol,
  timeframe,
  agg_start_utc,
  last_agg_bar_ts_utc AS cursor,
  status,
  is_mandatory
FROM data_agg_state
WHERE enabled = true
ORDER BY canonical_symbol, timeframe;
```

---

## Part 6: Testing Plan

### 6.1 Pre-Deployment Tests

**1. Dry-run sync function**:
```sql
-- Test sync without committing
BEGIN;
SELECT sync_agg_state_from_registry('prod', '2025-07-01 00:00:00+00');
SELECT canonical_symbol, timeframe, is_mandatory, agg_start_utc
FROM data_agg_state
ORDER BY canonical_symbol, timeframe;
ROLLBACK;
```

**2. Verify cursor bootstrap**:
```sql
-- Test bootstrap for one symbol
BEGIN;
SELECT agg_bootstrap_cursor('EURUSD', '5m');
SELECT last_agg_bar_ts_utc FROM data_agg_state 
WHERE canonical_symbol='EURUSD' AND timeframe='5m';
-- Should be 2025-07-01 00:00:00 - 5 minutes = 2025-06-30 23:55:00
ROLLBACK;
```

**3. Test single-table 1m query**:
```sql
-- Verify DXY 1m is readable from data_bars only
SELECT COUNT(*) FROM data_bars 
WHERE canonical_symbol='DXY' AND timeframe='1m';
-- Should be ~11,839

-- Verify no UNION needed
SELECT COUNT(*) FROM derived_data_bars 
WHERE canonical_symbol='DXY' AND timeframe='1m' AND deleted_at IS NULL;
-- Should be 0 (or 4,666 legacy before cleanup)
```

### 6.2 Post-Deployment Tests

**1. Manual aggregation test**:
```sql
-- Test DXY 5m aggregation
SELECT aggregate_1m_to_5m_window(
  'DXY',
  '2026-01-13 10:00:00+00'::timestamptz,
  '2026-01-13 10:05:00+00'::timestamptz,
  1
);
-- Expected: {success: true, stored: true, source_count: 5, quality_score: 2}
```

**2. Test catchup range**:
```sql
SELECT catchup_aggregation_range(
  'DXY',
  '5m',
  '2026-01-13 09:00:00+00'::timestamptz,
  12,  -- 1 hour of windows
  NOW(),
  1,
  true
);
-- Expected: 12 windows processed, 12 bars created
```

**3. Verify mandatory task priority**:
```sql
-- Should return mandatory tasks first
SELECT * FROM agg_get_due_tasks('prod', 20);
```

### 6.3 Integration Test

**Trigger full worker run**:
```bash
# Deploy updated worker
# Wait for next cron trigger or manual invoke
# Check logs for:
# - "Agg state synced" message
# - Tasks processing in order (mandatory first)
# - No UNION ALL errors
```

**Monitor results**:
```sql
SELECT 
  canonical_symbol,
  timeframe,
  total_runs,
  total_bars_created,
  last_successful_at_utc,
  last_error
FROM data_agg_state
WHERE total_runs > 0
ORDER BY canonical_symbol, timeframe;
```

---

## Part 7: Deployment Checklist

### Pre-Deployment
- [ ] Backup `data_agg_state` table
- [ ] Verify DXY 1m data in `data_bars` (11,839 bars)
- [ ] Test sync function in transaction (ROLLBACK after)
- [ ] Review migration SQL
- [ ] Schedule deployment window (low-traffic time)

### Deployment
- [ ] Run migration SQL: `011_aggregation_redesign.sql`
- [ ] Verify all active assets have 5m+1h tasks
- [ ] Check cursor positions (should be at agg_start_utc - interval)
- [ ] Deploy updated worker code
- [ ] Trigger manual worker run for testing

### Post-Deployment (First Hour)
- [ ] Monitor aggregation task execution
- [ ] Verify bars being created in `derived_data_bars`
- [ ] Check error logs for UNION ALL failures (should be none)
- [ ] Verify DXY aggregation working correctly
- [ ] Check mandatory tasks processing first

### Post-Deployment (24 Hours)
- [ ] Verify all symbols have recent 5m+1h bars
- [ ] Check quality score distribution
- [ ] Monitor hard_fail_streak (should be 0 for all mandatory)
- [ ] Performance metrics (query times, worker duration)

### Cleanup (After 48 Hours)
- [ ] Soft-delete legacy DXY 1m from `derived_data_bars`
- [ ] Drop old `calc_dxy_range_derived()` function (optional)
- [ ] Update documentation

---

## Part 8: Rollback Plan

### If Major Issues Detected

**1. Restore old functions**:
```sql
-- Keep backup of current functions
-- Restore previous versions with UNION ALL
-- (from aggregatorsql backup file)
```

**2. Revert worker code**:
```bash
# Redeploy previous worker version
# Without sync_agg_state_from_registry call
```

**3. Restore data_agg_state**:
```sql
-- If needed (last resort):
DROP TABLE data_agg_state;
CREATE TABLE data_agg_state AS 
SELECT * FROM data_agg_state_backup_20260113;
```

---

## Part 9: Success Metrics

### Functional Goals
- ✅ DXY aggregation works without UNION ALL
- ✅ All active assets have 5m+1h coverage
- ✅ Cursor positions respect agg_start_utc (2025-07-01)
- ✅ Mandatory tasks process first, never auto-disabled
- ✅ No "insufficient_source_bars" errors for DXY

### Performance Goals
- 🎯 1m aggregation queries 30-50% faster (single table)
- 🎯 Worker run time < 60 seconds for typical load
- 🎯 Quality score ≥ 1 (good) for 95%+ of bars
- 🎯 Hard fail streak = 0 for all mandatory tasks

### Operational Goals
- 🎯 No manual task creation needed (registry-driven)
- 🎯 New assets auto-get 5m+1h tasks on activation
- 🎯 Clear monitoring dashboard for mandatory failures

---

## Part 10: Future Enhancements

### Phase 6: Optional Timeframes
- Add support for 15m, 4h, 1d via registry metadata
- Create aggregation functions for these timeframes
- Update sync function to read `metadata.agg.optional`

### Phase 7: Advanced Features
- Backfill management (catchup from agg_start_utc to present)
- Quality thresholds (alert on poor quality)
- Dynamic priority adjustment (boost lagging tasks)
- Multi-region aggregation coordination

---

**End of Implementation Plan**

Next: Review and approve, then execute migration.
