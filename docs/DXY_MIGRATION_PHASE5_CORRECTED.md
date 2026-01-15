# DXY Migration Phase 5 - CORRECTED Implementation

**Date**: 2026-01-13  
**Status**: Bug Fixes Applied  
**Changes**: Fixed cursor semantics, removed incorrect UNION ALL, fixed source_count extraction

---

## Critical Fixes Applied

### 1. Cursor Semantics - NOW CORRECT ✅

**Contract** (from current code analysis):
```
last_agg_bar_ts_utc = start timestamp of the NEXT window to process
```

**Evidence from current code**:
- `catchup_aggregation_range`: `v_ws := v_cursor; v_we := v_ws + interval;`
- `agg_bootstrap_cursor`: Returns `boundary - interval` (positions cursor at next window to process)
- This means cursor = window start, and advances to next window start (v_we)

**This is CONSISTENT and CORRECT** - my review doc was wrong.

### 2. Source Table Rules - FIXED ✅

**Clean architecture**:
```
data_bars: timeframe = '1m' ONLY (including DXY synthetic)
derived_data_bars: timeframe = '5m', '1h', ... (all aggregated TFs)
```

**Aggregation functions**:
- `aggregate_1m_to_5m_window()`: Read ONLY from `data_bars` (1m source)
- `aggregate_5m_to_1h_window()`: Read ONLY from `derived_data_bars` (5m source) ✅ Already correct!
- `catchup_aggregation_range()`: Conditional source check (1m vs 5m)
- `agg_bootstrap_cursor()`: Conditional source check (1m vs 5m)

**NO UNION ALL needed anywhere**

### 3. Bug Fixes

#### Bug A: UNION ALL in aggregate_1m_to_5m_window
- ❌ Old: `UNION ALL` both data_bars + derived_data_bars
- ✅ Fixed: Read only from `data_bars`

#### Bug B: Source count extraction (NULLIF bug)
- ❌ Old: `v_source_rows := NULLIF((v_res->>'source_count')::int, NULL);`
- ✅ Fixed: `v_source_rows := COALESCE((v_res->>'source_count')::int, 0);`

#### Bug C: aggregate_5m_to_1h_window already correct
- ✅ Already reads only from `derived_data_bars` - NO CHANGE NEEDED

#### Bug D: Bootstrap UNION ALL needs conditional
- ❌ Old: Always UNION ALL for max source timestamp
- ✅ Fixed: Conditional based on source_timeframe

---

## Corrected SQL Functions

### Function 1: `aggregate_1m_to_5m_window()` - Remove UNION ALL

```sql
CREATE OR REPLACE FUNCTION aggregate_1m_to_5m_window(
  p_symbol text,
  p_from_utc timestamptz,
  p_to_utc timestamptz,
  p_derivation_version int DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cnt int;
  v_o double precision; v_c double precision; v_h double precision; v_l double precision;
  v_vol double precision; v_vwap double precision; v_tc int; v_q int;
BEGIN
  IF p_to_utc <= p_from_utc THEN
    RAISE EXCEPTION 'Invalid window';
  END IF;

  -- ✅ SINGLE TABLE - All 1m data (including DXY) now in data_bars
  WITH src AS (
    SELECT ts_utc, open, high, low, close, vol, vwap, trade_count
    FROM data_bars
    WHERE canonical_symbol = p_symbol
      AND timeframe = '1m'
      AND ts_utc >= p_from_utc
      AND ts_utc < p_to_utc
  ),
  ordered AS (
    SELECT * FROM src ORDER BY ts_utc ASC
  ),
  agg AS (
    SELECT 
      COUNT(*) AS cnt,
      (array_agg(open ORDER BY ts_utc ASC))[1] AS o,
      (array_agg(close ORDER BY ts_utc ASC))[COUNT(*)] AS c,
      MAX(high) AS h,
      MIN(low) AS l,
      SUM(COALESCE(vol, 0)) AS vol_sum,
      CASE 
        WHEN SUM(COALESCE(vol, 0)) > 0 
        THEN SUM(COALESCE(vwap, 0) * COALESCE(vol, 0)) / NULLIF(SUM(COALESCE(vol, 0)), 0)
        ELSE NULL
      END AS vwap_calc,
      SUM(COALESCE(trade_count, 0))::int AS tc_sum
    FROM ordered
  )
  SELECT cnt, o, c, h, l, vol_sum, vwap_calc, tc_sum
  INTO v_cnt, v_o, v_c, v_h, v_l, v_vol, v_vwap, v_tc
  FROM agg;

  -- Quality scoring: 5 bars = excellent, 4 = good, 3 = poor, <3 = skip
  IF v_cnt >= 5 THEN
    v_q := 2;
  ELSIF v_cnt = 4 THEN
    v_q := 1;
  ELSIF v_cnt = 3 THEN
    v_q := 0;
  ELSE
    RETURN jsonb_build_object(
      'success', true,
      'stored', false,
      'reason', 'insufficient_source_bars',
      'source_count', v_cnt
    );
  END IF;

  -- Upsert to derived_data_bars
  PERFORM _upsert_derived_bar(
    p_symbol, '5m', p_from_utc,
    v_o, v_h, v_l, v_c,
    v_vol, v_vwap, v_tc,
    'agg', '1m', v_cnt, 5, v_q, p_derivation_version,
    jsonb_build_object(
      'from', p_from_utc,
      'to', p_to_utc,
      'source', 'data_bars_1m_only'
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'stored', true,
    'source_count', v_cnt,
    'quality_score', v_q
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION aggregate_1m_to_5m_window(text,timestamptz,timestamptz,int) FROM public;
GRANT EXECUTE ON FUNCTION aggregate_1m_to_5m_window(text,timestamptz,timestamptz,int) TO service_role;
```

### Function 2: `aggregate_5m_to_1h_window()` - NO CHANGE (Already Correct) ✅

Current implementation is correct - already reads only from `derived_data_bars`.

**No changes needed.**

### Function 3: `agg_bootstrap_cursor()` - Conditional Source Check

```sql
CREATE OR REPLACE FUNCTION agg_bootstrap_cursor(
  p_symbol text,
  p_to_tf text,
  p_now_utc timestamptz DEFAULT NOW()
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_interval_min int;
  v_src_tf text;
  v_agg_start_utc timestamptz;  -- NEW: enforce minimum start date
  v_latest timestamptz;
  v_latest_ms bigint;
  v_interval_ms bigint;
  v_boundary_ms bigint;
  v_bootstrap_cursor timestamptz;
BEGIN
  -- Get config including new agg_start_utc
  SELECT run_interval_minutes, source_timeframe, agg_start_utc
  INTO v_interval_min, v_src_tf, v_agg_start_utc
  FROM data_agg_state
  WHERE canonical_symbol = p_symbol AND timeframe = p_to_tf;

  IF v_interval_min IS NULL OR v_src_tf IS NULL THEN
    RAISE EXCEPTION 'Missing config in data_agg_state for %/%', p_symbol, p_to_tf;
  END IF;

  -- ✅ CONDITIONAL SOURCE CHECK - no UNION ALL needed
  IF v_src_tf = '1m' THEN
    -- For 1m source: only query data_bars
    SELECT MAX(ts_utc) INTO v_latest
    FROM data_bars
    WHERE canonical_symbol = p_symbol AND timeframe = v_src_tf;
  ELSE
    -- For 5m+ source: only query derived_data_bars
    SELECT MAX(ts_utc) INTO v_latest
    FROM derived_data_bars
    WHERE canonical_symbol = p_symbol 
      AND timeframe = v_src_tf 
      AND deleted_at IS NULL;
  END IF;

  v_interval_ms := v_interval_min::bigint * 60000;

  IF v_latest IS NULL THEN
    -- No data: use agg_start_utc as reference
    v_latest_ms := FLOOR(EXTRACT(epoch FROM COALESCE(v_agg_start_utc, p_now_utc)) * 1000)::bigint;
    v_boundary_ms := (v_latest_ms / v_interval_ms) * v_interval_ms;
    v_bootstrap_cursor := to_timestamp((v_boundary_ms + v_interval_ms) / 1000.0)::timestamptz;
  ELSE
    -- Have data: cursor = latest boundary - interval
    v_latest_ms := FLOOR(EXTRACT(epoch FROM v_latest) * 1000)::bigint;
    v_boundary_ms := (v_latest_ms / v_interval_ms) * v_interval_ms;
    v_bootstrap_cursor := to_timestamp((v_boundary_ms - v_interval_ms) / 1000.0)::timestamptz;
  END IF;

  -- ✅ ENFORCE MINIMUM: cursor cannot be before agg_start_utc - interval
  IF v_agg_start_utc IS NOT NULL THEN
    v_bootstrap_cursor := GREATEST(
      v_bootstrap_cursor,
      v_agg_start_utc - (v_interval_min || ' minutes')::interval
    );
  END IF;

  RETURN v_bootstrap_cursor;
END;
$$;

REVOKE EXECUTE ON FUNCTION agg_bootstrap_cursor(text,text,timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION agg_bootstrap_cursor(text,text,timestamptz) TO service_role;
```

### Function 4: `catchup_aggregation_range()` - Add Start Date Guard + Fix Source Count

```sql
CREATE OR REPLACE FUNCTION catchup_aggregation_range(
  p_symbol text,
  p_to_tf text,                      -- '5m' or '1h'
  p_start_cursor_utc timestamptz,
  p_max_windows integer DEFAULT 100,
  p_now_utc timestamptz DEFAULT NULL,
  p_derivation_version int DEFAULT 1,
  p_ignore_confirmation boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := COALESCE(p_now_utc, NOW());
  v_interval_min int;
  v_delay_sec int;
  v_agg_start_utc timestamptz;  -- NEW: enforce minimum start date
  
  v_cursor timestamptz := p_start_cursor_utc;
  v_ws timestamptz;
  v_we timestamptz;
  v_confirm timestamptz;
  
  v_processed int := 0;
  v_created int := 0;
  v_poor int := 0;
  v_skipped int := 0;
  v_source_count int;
  
  v_res jsonb;
  v_stored boolean;
  v_q int;
BEGIN
  -- Get config including new agg_start_utc
  SELECT run_interval_minutes, aggregation_delay_seconds, agg_start_utc
  INTO v_interval_min, v_delay_sec, v_agg_start_utc
  FROM data_agg_state
  WHERE canonical_symbol = p_symbol AND timeframe = p_to_tf;

  IF v_interval_min IS NULL THEN
    RAISE EXCEPTION 'Missing agg config for %/%', p_symbol, p_to_tf;
  END IF;

  -- ✅ ENFORCE MINIMUM: cursor cannot be before agg_start_utc - interval
  IF v_agg_start_utc IS NOT NULL THEN
    v_cursor := GREATEST(
      v_cursor,
      v_agg_start_utc - (v_interval_min || ' minutes')::interval
    );
  END IF;

  -- Process windows
  WHILE v_processed < p_max_windows LOOP
    -- ✅ CORRECT CURSOR SEMANTICS: cursor = next window start
    v_ws := v_cursor;
    v_we := v_ws + make_interval(mins => v_interval_min);
    v_confirm := v_we + make_interval(secs => v_delay_sec);

    -- ✅ GUARD: Don't aggregate before agg_start_utc
    IF v_agg_start_utc IS NOT NULL AND v_ws < v_agg_start_utc THEN
      -- Skip this window, advance cursor
      v_cursor := v_we;
      v_processed := v_processed + 1;
      CONTINUE;
    END IF;

    -- Stop if we haven't reached confirmation time yet
    IF (NOT p_ignore_confirmation) AND v_now < v_confirm THEN
      EXIT;
    END IF;

    -- Call appropriate aggregation function
    IF p_to_tf = '5m' THEN
      v_res := aggregate_1m_to_5m_window(p_symbol, v_ws, v_we, p_derivation_version);
    ELSIF p_to_tf = '1h' THEN
      v_res := aggregate_5m_to_1h_window(p_symbol, v_ws, v_we, p_derivation_version);
    ELSE
      RAISE EXCEPTION 'Unsupported tf=%', p_to_tf;
    END IF;

    -- ✅ FIXED: Proper source_count extraction
    v_source_count := COALESCE((v_res->>'source_count')::int, 0);
    v_stored := COALESCE((v_res->>'stored')::boolean, false);

    -- ✅ STOP AT DATA FRONTIER: if no source bars, we've reached the end
    IF v_source_count = 0 THEN
      EXIT;
    END IF;

    -- Track stats
    IF v_stored THEN
      v_created := v_created + 1;
      v_q := COALESCE((v_res->>'quality_score')::int, 0);
      IF v_q <= 0 THEN
        v_poor := v_poor + 1;
      END IF;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;

    -- ✅ CORRECT: Advance cursor to next window start
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
    'continue', (v_processed = p_max_windows),
    'agg_start_enforced', v_agg_start_utc
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION catchup_aggregation_range(text,text,timestamptz,integer,timestamptz,int,boolean) FROM public;
GRANT EXECUTE ON FUNCTION catchup_aggregation_range(text,text,timestamptz,integer,timestamptz,int,boolean) TO service_role;
```

### Function 5: `sync_agg_state_from_registry()` - Registry-Driven Tasks

```sql
CREATE OR REPLACE FUNCTION sync_agg_state_from_registry(
  p_env text DEFAULT 'prod',
  p_default_start_utc timestamptz DEFAULT '2025-07-01 00:00:00+00'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted integer := 0;
  v_updated integer := 0;
  v_disabled integer := 0;
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
      300 AS aggregation_delay_seconds,
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
    agg_start_utc = EXCLUDED.agg_start_utc,
    updated_at = NOW();
  
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  
  -- 2) Disable tasks for assets that are no longer active
  WITH active_symbols AS (
    SELECT canonical_symbol 
    FROM core_asset_registry_all 
    WHERE is_active = true
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
    'tasks_synced', v_inserted,
    'tasks_disabled', v_disabled,
    'default_start_utc', p_default_start_utc
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION sync_agg_state_from_registry(text,timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION sync_agg_state_from_registry(text,timestamptz) TO service_role;
```

### Function 6: `agg_get_due_tasks()` - Mandatory-First Ordering

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
SECURITY DEFINER
SET search_path = public
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
    is_mandatory DESC,                        -- Mandatory tasks first
    timeframe ASC,                            -- 5m before 1h
    task_priority ASC,                        -- Lower priority = higher urgency
    last_successful_at_utc ASC NULLS FIRST    -- Never-run tasks first
  LIMIT p_limit;
$$;

REVOKE EXECUTE ON FUNCTION agg_get_due_tasks(text,integer) FROM public;
GRANT EXECUTE ON FUNCTION agg_get_due_tasks(text,integer) TO service_role;
```

---

## Schema Changes

```sql
-- Add new columns to data_agg_state
ALTER TABLE data_agg_state
  ADD COLUMN IF NOT EXISTS agg_start_utc timestamptz 
    NOT NULL DEFAULT '2025-07-01 00:00:00+00',
  ADD COLUMN IF NOT EXISTS enabled boolean 
    NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS task_priority integer 
    NOT NULL DEFAULT 100;

-- Add index for priority-based selection
CREATE INDEX IF NOT EXISTS idx_agg_state_priority
  ON data_agg_state (
    is_mandatory DESC, 
    timeframe ASC, 
    task_priority ASC, 
    last_successful_at_utc ASC NULLS FIRST
  )
  WHERE status = 'idle' AND enabled = true;

-- Add comments
COMMENT ON COLUMN data_agg_state.agg_start_utc IS 
  'First timestamp to start aggregation. Nothing will be aggregated before this date.';
COMMENT ON COLUMN data_agg_state.enabled IS 
  'Whether this task is active. Disabled tasks are skipped completely.';
COMMENT ON COLUMN data_agg_state.task_priority IS 
  'Lower = higher priority. Tie-breaker after mandatory/timeframe sorting.';
```

---

## Summary of Changes

### ✅ What Was Fixed

1. **Cursor semantics**: Kept consistent with current implementation (cursor = next window start)
2. **UNION ALL removed**: `aggregate_1m_to_5m_window()` now reads only from `data_bars`
3. **Source count bug fixed**: Changed from `NULLIF` to `COALESCE`
4. **Conditional source checks**: Bootstrap and catchup use conditional logic (1m vs 5m)
5. **Start date enforcement**: All functions respect `agg_start_utc` minimum
6. **aggregate_5m_to_1h_window**: NO CHANGE (already correct)

### ❌ What Was Removed (Over-Engineering)

1. Removed UNION ALL from 5m→1h aggregation (it was already correct)
2. Kept verification concerns OUT of aggregation layer
3. Simplified frontier logic (rely on source_count = 0)

### 🎯 Architecture After Migration

```
Source Tables:
  data_bars: timeframe='1m' ONLY (including DXY synthetic)
  derived_data_bars: timeframe='5m','1h',... (all aggregated)

Aggregation Functions:
  aggregate_1m_to_5m_window: reads data_bars (1m)
  aggregate_5m_to_1h_window: reads derived_data_bars (5m)
  
No UNION ALL anywhere in aggregation layer.
```

---

## Next Steps

1. **Review this corrected version**
2. **Create migration SQL file** (011_aggregation_redesign.sql)
3. **Test in transaction** before deploying
4. **Deploy to production**

The bugs have been fixed. Ready to proceed?
