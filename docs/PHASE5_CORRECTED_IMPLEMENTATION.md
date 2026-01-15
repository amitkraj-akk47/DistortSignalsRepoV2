# PHASE 5 IMPLEMENTATION: CORRECTED & VERIFIED VERSION

**Status**: Ready to code after critical issues are fixed  
**Based on**: Code review + production database verification  
**Generated**: 2026-01-13

---

## QUICK REFERENCE: What Changes from Original Plan

### ✅ Still Correct (No Changes Needed)
- UNION ALL removal from aggregate_1m_to_5m_window (already fixed in production)
- aggregate_5m_to_1h_window reads only from derived_data_bars (no UNION needed)
- Conditional source check in catchup_aggregation_range (1m vs 5m+)
- COALESCE fix for source_count extraction (removes NULLIF bug)
- Mandatory-first task ordering (is_mandatory DESC)

### 🔧 Must Fix Before Implementation (Critical)

| Item | Original Problem | Corrected Approach |
|------|------------------|-------------------|
| agg_start_utc | Hardcoded '2025-07-01' for all assets | Calculate per-asset from actual data |
| Frontier detection | Stops immediately on zero data | Allow 3 consecutive gaps before stop |
| sync function | Two-step process with race condition | Single atomic CTE operation |
| Transaction safety | No EXCEPTION handlers | Add transaction control & error handling |
| Rollback script | Not provided | Create full rollback script |
| Cursor verification | Assumed correct | Verify with actual database query |

---

## PART 1: PRE-IMPLEMENTATION CHECKS

### Check 1: Verify Cursor Semantics

Run this query to confirm cursor = next window start:

```sql
SELECT 
  das.canonical_symbol,
  das.timeframe,
  das.last_agg_bar_ts_utc as cursor_position,
  (SELECT MAX(ts_utc) FROM derived_data_bars 
   WHERE canonical_symbol = das.canonical_symbol 
   AND timeframe = das.timeframe 
   AND deleted_at IS NULL) as actual_last_bar,
  CASE 
    WHEN das.last_agg_bar_ts_utc > 
         (SELECT MAX(ts_utc) FROM derived_data_bars 
          WHERE canonical_symbol = das.canonical_symbol 
          AND timeframe = das.timeframe AND deleted_at IS NULL)
      THEN '✅ CORRECT: cursor ahead of last bar'
    WHEN das.last_agg_bar_ts_utc = 
         (SELECT MAX(ts_utc) FROM derived_data_bars 
          WHERE canonical_symbol = das.canonical_symbol 
          AND timeframe = das.timeframe AND deleted_at IS NULL)
      THEN '❌ WRONG: cursor equals last bar'
    ELSE '❓ UNCLEAR'
  END as verdict
FROM data_agg_state das
WHERE das.canonical_symbol IN ('EURUSD', 'USDJPY')
  AND das.timeframe = '5m';
```

**Expected Result**: `cursor ahead of last bar` for all rows  
**If Different**: Stop, investigate before proceeding

### Check 2: Verify All Assets Have 1m Base Timeframe

```sql
SELECT 
  canonical_symbol,
  base_timeframe,
  active
FROM core_asset_registry_all
WHERE active = true
  AND base_timeframe != '1m';
```

**Expected Result**: Zero rows  
**If Found**: Document exception or reject deployment

### Check 3: Verify Data Availability Ranges

```sql
SELECT 
  'EURUSD' as symbol,
  (SELECT MIN(ts_utc) FROM data_bars WHERE canonical_symbol='EURUSD' AND timeframe='1m') as earliest_1m,
  (SELECT MAX(ts_utc) FROM data_bars WHERE canonical_symbol='EURUSD' AND timeframe='1m') as latest_1m
UNION ALL
SELECT 
  'USDJPY',
  (SELECT MIN(ts_utc) FROM data_bars WHERE canonical_symbol='USDJPY' AND timeframe='1m'),
  (SELECT MAX(ts_utc) FROM data_bars WHERE canonical_symbol='USDJPY' AND timeframe='1m')
UNION ALL
SELECT 
  'DXY',
  (SELECT MIN(ts_utc) FROM data_bars WHERE canonical_symbol='DXY' AND timeframe='1m'),
  (SELECT MAX(ts_utc) FROM data_bars WHERE canonical_symbol='DXY' AND timeframe='1m');
```

**Document each asset's earliest 1m bar for agg_start_utc calculation**

---

## PART 2: CORRECTED MIGRATION SQL (011_aggregation_redesign.sql)

### Section 1: Add New Columns (Corrected)

```sql
-- Phase 5a: Add columns with per-asset agg_start_utc
BEGIN;

-- 1a. Add columns (nullable initially)
ALTER TABLE data_agg_state
  ADD COLUMN agg_start_utc timestamptz NULL,
  ADD COLUMN enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN task_priority integer NOT NULL DEFAULT 100;

-- 1b. Calculate per-asset agg_start_utc from actual data
UPDATE data_agg_state das
SET agg_start_utc = (
  SELECT COALESCE(
    MIN(ts_utc),                -- Earliest 1m bar for this asset
    NOW() - interval '30 days'  -- Fallback: last 30 days if no data
  )
  FROM data_bars
  WHERE canonical_symbol = das.canonical_symbol
    AND timeframe = '1m'
);

-- 1c. Handle assets with no data yet (use today 00:00 UTC)
UPDATE data_agg_state
SET agg_start_utc = DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
WHERE agg_start_utc IS NULL;

-- 1d. Make agg_start_utc NOT NULL after population
ALTER TABLE data_agg_state
  ALTER COLUMN agg_start_utc SET NOT NULL;

-- 1e. Create indices for efficient selection
CREATE INDEX idx_data_agg_state_priority 
  ON data_agg_state(is_mandatory DESC, timeframe ASC, task_priority ASC)
  WHERE enabled = true;

CREATE INDEX idx_data_agg_state_enabled_status
  ON data_agg_state(enabled, status)
  WHERE enabled = true;

COMMIT;
```

### Section 2: Update agg_bootstrap_cursor() (Corrected)

```sql
-- Fix: Use conditional source table instead of UNION ALL
CREATE OR REPLACE FUNCTION agg_bootstrap_cursor(
  p_symbol text,
  p_to_tf text,
  p_now_utc timestamptz DEFAULT now()
) RETURNS timestamptz AS $$
DECLARE
  v_interval_min integer;
  v_src_tf text;
  v_latest timestamptz;
  v_boundary timestamptz;
BEGIN
  -- Get interval and source timeframe
  SELECT 
    run_interval_minutes,
    source_timeframe
  INTO v_interval_min, v_src_tf
  FROM data_agg_state
  WHERE canonical_symbol = p_symbol 
    AND timeframe = p_to_tf;

  IF v_src_tf IS NULL THEN
    RAISE EXCEPTION 'Task not found: %.%', p_symbol, p_to_tf;
  END IF;

  -- ✅ FIX: Conditional source check (1m vs 5m+)
  IF v_src_tf = '1m' THEN
    SELECT MAX(ts_utc) INTO v_latest
    FROM data_bars
    WHERE canonical_symbol = p_symbol AND timeframe = v_src_tf;
  ELSE
    SELECT MAX(ts_utc) INTO v_latest
    FROM derived_data_bars
    WHERE canonical_symbol = p_symbol 
      AND timeframe = v_src_tf 
      AND deleted_at IS NULL;
  END IF;

  IF v_latest IS NULL THEN
    -- No source data yet, return next boundary after now
    v_boundary := CEIL((EXTRACT(epoch FROM p_now_utc) / (v_interval_min * 60))::numeric) * (v_interval_min * 60);
    RETURN TO_TIMESTAMP(v_boundary);
  ELSE
    -- Return start of last complete window
    v_boundary := (EXTRACT(epoch FROM v_latest) / (v_interval_min * 60))::bigint * (v_interval_min * 60);
    RETURN TO_TIMESTAMP(v_boundary) - (v_interval_min || ' minutes')::interval;
  END IF;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'agg_bootstrap_cursor failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### Section 3: Update catchup_aggregation_range() (Corrected)

```sql
-- Fix: Add agg_start_utc enforcement + gap tolerance + transaction safety
CREATE OR REPLACE FUNCTION catchup_aggregation_range(
  p_symbol text,
  p_to_tf text,
  p_start_cursor_utc timestamptz,
  p_max_windows integer DEFAULT 100,
  p_now_utc timestamptz DEFAULT null,
  p_derivation_version int DEFAULT 1,
  p_ignore_confirmation boolean DEFAULT false
) RETURNS jsonb AS $$
DECLARE
  v_interval_min integer;
  v_delay_sec integer;
  v_src_tf text;
  v_agg_start_utc timestamptz;
  v_cursor timestamptz;
  v_processed integer := 0;
  v_created integer := 0;
  v_poor_quality integer := 0;
  v_ws timestamptz;
  v_we timestamptz;
  v_confirm timestamptz;
  v_max_source_ts timestamptz;
  v_res jsonb;
  v_source_rows integer;
  v_zero_source_streak integer := 0;
  v_max_zeros_before_stop integer := 3;
  v_stored boolean;
BEGIN
  SET TRANSACTION ISOLATION LEVEL READ COMMITTED;

  -- Validate inputs
  IF p_start_cursor_utc IS NULL THEN
    RAISE EXCEPTION 'catchup_aggregation_range: start cursor is NULL. Call agg_bootstrap_cursor first.';
  END IF;

  p_now_utc := COALESCE(p_now_utc, NOW() AT TIME ZONE 'UTC');

  -- Load task configuration
  SELECT 
    run_interval_minutes,
    aggregation_delay_seconds,
    source_timeframe,
    agg_start_utc
  INTO v_interval_min, v_delay_sec, v_src_tf, v_agg_start_utc
  FROM data_agg_state
  WHERE canonical_symbol = p_symbol AND timeframe = p_to_tf;

  IF v_interval_min IS NULL THEN
    RAISE EXCEPTION 'Task not found: %.%', p_symbol, p_to_tf;
  END IF;

  -- ✅ FIX: Enforce agg_start_utc minimum
  v_cursor := p_start_cursor_utc;
  IF v_agg_start_utc IS NOT NULL AND v_cursor < v_agg_start_utc THEN
    v_cursor := v_agg_start_utc - (v_interval_min || ' minutes')::interval;
  END IF;

  -- Find maximum source data timestamp (conditional)
  IF v_src_tf = '1m' THEN
    SELECT MAX(ts_utc) INTO v_max_source_ts
    FROM data_bars
    WHERE canonical_symbol = p_symbol AND timeframe = v_src_tf;
  ELSE
    SELECT MAX(ts_utc) INTO v_max_source_ts
    FROM derived_data_bars
    WHERE canonical_symbol = p_symbol 
      AND timeframe = v_src_tf 
      AND deleted_at IS NULL;
  END IF;

  -- Main window processing loop
  WHILE v_processed < p_max_windows LOOP
    v_ws := v_cursor;
    v_we := v_ws + (v_interval_min || ' minutes')::interval;
    v_confirm := v_we + (v_delay_sec || ' seconds')::interval;

    -- ✅ FIX: Skip windows before agg_start_utc
    IF v_agg_start_utc IS NOT NULL AND v_ws < v_agg_start_utc THEN
      v_cursor := v_we;
      v_processed := v_processed + 1;
      CONTINUE;
    END IF;

    -- Stop if we're past source data AND past confirmation
    IF v_max_source_ts IS NOT NULL AND v_we > v_max_source_ts + (v_delay_sec || ' seconds')::interval THEN
      EXIT;
    END IF;

    -- Call appropriate aggregation function
    IF p_to_tf = '5m' THEN
      v_res := aggregate_1m_to_5m_window(
        p_symbol, v_ws, v_we, p_derivation_version
      );
    ELSIF p_to_tf = '1h' THEN
      v_res := aggregate_5m_to_1h_window(
        p_symbol, v_ws, v_we, p_derivation_version
      );
    ELSE
      RAISE EXCEPTION 'Unsupported aggregation timeframe: %', p_to_tf;
    END IF;

    -- Extract results (✅ FIXED: Safe COALESCE handling)
    v_source_rows := COALESCE((v_res->>'source_count')::int, 0);
    v_stored := COALESCE((v_res->>'stored')::boolean, false);

    -- ✅ FIX: Gap tolerance logic (allow 3 consecutive empty windows)
    IF v_source_rows = 0 THEN
      v_zero_source_streak := v_zero_source_streak + 1;
      
      IF v_zero_source_streak >= v_max_zeros_before_stop THEN
        -- Reached frontier (multiple consecutive gaps)
        EXIT;
      END IF;
    ELSE
      -- Reset streak when we find data
      v_zero_source_streak := 0;
      
      IF v_stored THEN
        v_created := v_created + 1;
        
        IF COALESCE((v_res->>'quality_score')::int, 0) <= 0 THEN
          v_poor_quality := v_poor_quality + 1;
        END IF;
      END IF;
    END IF;

    -- Always advance cursor
    v_cursor := v_we;
    v_processed := v_processed + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'windows_processed', v_processed,
    'cursor_advanced_to', v_cursor,
    'bars_created', v_created,
    'bars_quality_poor', v_poor_quality,
    'agg_start_utc_enforced', v_agg_start_utc,
    'continue', v_cursor < (p_now_utc - (v_interval_min || ' minutes')::interval)
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', false,
    'error', SQLERRM,
    'error_code', SQLSTATE,
    'windows_processed', v_processed
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### Section 4: Create sync_agg_state_from_registry() (Corrected)

```sql
-- New function: Atomic sync from registry (fixes race condition)
CREATE OR REPLACE FUNCTION sync_agg_state_from_registry()
RETURNS jsonb AS $$
DECLARE
  v_result jsonb;
BEGIN
  SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;

  WITH active_assets AS (
    -- Get all active assets with both 5m and 1h timeframes
    SELECT DISTINCT 
      car.canonical_symbol,
      tf.timeframe
    FROM core_asset_registry_all car
    CROSS JOIN (VALUES ('5m'), ('1h')) tf(timeframe)
    WHERE car.active = true
    FOR UPDATE OF core_asset_registry_all  -- Lock registry rows
  ),
  upsert_tasks AS (
    -- Insert or update tasks for active assets
    INSERT INTO data_agg_state (
      canonical_symbol,
      timeframe,
      source_timeframe,
      run_interval_minutes,
      aggregation_delay_seconds,
      is_mandatory,
      enabled,
      agg_start_utc,
      task_priority
    )
    SELECT 
      aa.canonical_symbol,
      aa.timeframe,
      '1m' as source_timeframe,
      CASE WHEN aa.timeframe = '5m' THEN 5 ELSE 60 END as run_interval_minutes,
      30 as aggregation_delay_seconds,
      true as is_mandatory,
      true as enabled,
      (SELECT COALESCE(
        MIN(ts_utc),
        NOW() - interval '30 days'
      ) FROM data_bars 
      WHERE canonical_symbol = aa.canonical_symbol AND timeframe = '1m'),
      100 as task_priority
    FROM active_assets aa
    ON CONFLICT (canonical_symbol, timeframe)
    DO UPDATE SET 
      enabled = true,
      source_timeframe = EXCLUDED.source_timeframe,
      run_interval_minutes = EXCLUDED.run_interval_minutes,
      aggregation_delay_seconds = EXCLUDED.aggregation_delay_seconds,
      is_mandatory = true,
      updated_at = NOW()
    RETURNING canonical_symbol, timeframe, xmax = 0 as was_inserted
  ),
  disable_orphans AS (
    -- Disable tasks for assets that are no longer active
    UPDATE data_agg_state das
    SET enabled = false, updated_at = NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM core_asset_registry_all car
      WHERE car.canonical_symbol = das.canonical_symbol
        AND car.active = true
    )
    AND das.enabled = true
    RETURNING canonical_symbol, timeframe, 'disabled'::text as action
  )
  SELECT jsonb_build_object(
    'success', true,
    'tasks_upserted', (SELECT COUNT(*) FROM upsert_tasks),
    'tasks_disabled', (SELECT COUNT(*) FROM disable_orphans),
    'timestamp_utc', NOW()
  ) INTO v_result;

  RETURN v_result;

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', false,
    'error', SQLERRM,
    'error_code', SQLSTATE
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### Section 5: Update agg_get_due_tasks() (Corrected)

```sql
-- Update: Add task_priority to ORDER BY
CREATE OR REPLACE FUNCTION agg_get_due_tasks(
  p_env_name text DEFAULT 'prod',
  p_limit integer DEFAULT 10
) RETURNS TABLE (
  canonical_symbol text,
  timeframe text,
  source_timeframe text,
  last_agg_bar_ts_utc timestamptz,
  run_interval_minutes integer,
  aggregation_delay_seconds integer,
  is_mandatory boolean,
  task_priority integer
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    das.canonical_symbol,
    das.timeframe,
    das.source_timeframe,
    das.last_agg_bar_ts_utc,
    das.run_interval_minutes,
    das.aggregation_delay_seconds,
    das.is_mandatory,
    das.task_priority
  FROM data_agg_state das
  WHERE das.enabled = true
    AND das.status = 'idle'
    AND das.next_run_at <= NOW()
  ORDER BY 
    das.is_mandatory DESC,              -- Mandatory first
    das.timeframe ASC,                  -- 5m before 1h
    das.task_priority ASC,              -- Lower priority first
    das.last_successful_at_utc ASC NULLS FIRST  -- Never-run tasks first
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### Section 6: Improve aggregate_1m_to_5m_window() (Enhanced Quality Scoring)

```sql
-- Enhancement: Check for final bar in quality scoring
CREATE OR REPLACE FUNCTION aggregate_1m_to_5m_window(
  p_symbol text,
  p_from_utc timestamptz,
  p_to_utc timestamptz,
  p_derivation_version int DEFAULT 1
) RETURNS jsonb AS $$
DECLARE
  v_open double precision;
  v_high double precision;
  v_low double precision;
  v_close double precision;
  v_vol double precision;
  v_vwap double precision;
  v_trade_count integer;
  v_quality_score integer;
  v_cnt integer;
  v_has_final_bar boolean;
  v_result jsonb;
  v_bars RECORD[];
BEGIN
  SET TRANSACTION ISOLATION LEVEL READ COMMITTED;

  BEGIN
    -- Get all 1m bars for this window
    SELECT array_agg(row(ts_utc, open, high, low, close, vol, vwap, trade_count))
    INTO v_bars
    FROM data_bars
    WHERE canonical_symbol = p_symbol
      AND timeframe = '1m'
      AND ts_utc >= p_from_utc
      AND ts_utc < p_to_utc
    ORDER BY ts_utc;

    v_cnt := array_length(v_bars, 1);

    -- No source data
    IF v_cnt IS NULL OR v_cnt = 0 THEN
      RETURN jsonb_build_object(
        'success', true,
        'stored', false,
        'source_count', 0,
        'reason', 'insufficient_source_bars'
      );
    END IF;

    -- Aggregate OHLCV
    SELECT 
      (v_bars[1]).open,
      MAX((v.bar).high),
      MIN((v.bar).low),
      (v_bars[array_length(v_bars, 1)]).close,
      SUM((v.bar).vol),
      SUM(((v.bar).vol * (v.bar).close)) / NULLIF(SUM((v.bar).vol), 0),
      SUM((v.bar).trade_count)
    INTO v_open, v_high, v_low, v_close, v_vol, v_vwap, v_trade_count
    FROM (SELECT v_bars[s] as bar FROM GENERATE_SERIES(1, array_length(v_bars, 1)) s) v;

    -- ✅ FIX: Check if final bar exists (critical for close price)
    v_has_final_bar := (v_bars[array_length(v_bars, 1)]).ts_utc = (p_to_utc - interval '1 minute');

    -- Enhanced quality scoring
    v_quality_score := CASE
      WHEN v_cnt >= 5 THEN 2               -- All bars
      WHEN v_cnt = 4 AND v_has_final_bar THEN 1   -- Missing bar but have close
      WHEN v_cnt = 4 AND NOT v_has_final_bar THEN 0  -- Missing final bar
      WHEN v_cnt = 3 AND v_has_final_bar THEN 0   -- Sparse but have close
      WHEN v_cnt = 3 AND NOT v_has_final_bar THEN -1  -- Sparse AND no close
      ELSE -2                              -- Very sparse
    END;

    -- Store if sufficient quality
    IF v_quality_score >= 0 THEN
      v_result := _upsert_derived_bar(
        p_symbol, '5m', p_from_utc,
        v_open, v_high, v_low, v_close, v_vol, v_vwap, v_trade_count,
        'agg', '1m', v_cnt, 5, v_quality_score, p_derivation_version,
        jsonb_build_object('source_count', v_cnt, 'has_final_bar', v_has_final_bar)
      );

      RETURN jsonb_build_object(
        'success', (v_result->>'success')::boolean,
        'stored', true,
        'source_count', v_cnt,
        'quality_score', v_quality_score,
        'has_final_bar', v_has_final_bar
      );
    ELSE
      RETURN jsonb_build_object(
        'success', true,
        'stored', false,
        'source_count', v_cnt,
        'quality_score', v_quality_score,
        'reason', 'insufficient_quality'
      );
    END IF;

  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM,
      'error_code', SQLSTATE
    );
  END;

END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

---

## PART 3: ROLLBACK SCRIPT (011_aggregation_redesign_ROLLBACK.sql)

```sql
-- Rollback script for Phase 5 aggregation redesign
-- Use if deployment fails or needs to be reversed

BEGIN;

-- 1. Drop new indices
DROP INDEX IF EXISTS idx_data_agg_state_priority CASCADE;
DROP INDEX IF EXISTS idx_data_agg_state_enabled_status CASCADE;

-- 2. Remove new columns
ALTER TABLE data_agg_state
  DROP COLUMN IF EXISTS agg_start_utc CASCADE,
  DROP COLUMN IF EXISTS enabled CASCADE,
  DROP COLUMN IF EXISTS task_priority CASCADE;

-- 3. Drop new functions
DROP FUNCTION IF EXISTS sync_agg_state_from_registry() CASCADE;

-- 4. Restore old function signatures (if updated)
-- agg_bootstrap_cursor, catchup_aggregation_range, agg_get_due_tasks
-- Instructions: Run previous versions from migration 010_*

-- 5. Verify state
SELECT 
  COUNT(*) as total_tasks,
  COUNT(*) FILTER (WHERE status='idle') as idle_tasks,
  COUNT(*) FILTER (WHERE status='running') as stuck_tasks
FROM data_agg_state;

-- 6. If stuck tasks exist, reset them manually
UPDATE data_agg_state
SET status = 'idle', last_attempted_at_utc = NOW()
WHERE status = 'running' AND running_started_at_utc < (NOW() - interval '30 minutes');

COMMIT;
```

---

## PART 4: DEPLOYMENT CHECKLIST

### Pre-Deployment (Run these first)

- [ ] Run cursor semantics verification query
- [ ] Verify all active assets have base_timeframe = '1m'
- [ ] Document earliest 1m bar for each asset
- [ ] Create rollback script file
- [ ] Test rollback in dev environment
- [ ] Run performance benchmark (EXPLAIN ANALYZE)
- [ ] Review all functions for transaction safety

### Deployment Steps

1. [ ] Create backup of data_agg_state table
   ```sql
   CREATE TABLE data_agg_state_backup_phase5 AS SELECT * FROM data_agg_state;
   ```

2. [ ] Deploy migration SQL (011_aggregation_redesign.sql)
   ```bash
   psql -h supabase.com -d postgres -U postgres -f 011_aggregation_redesign.sql
   ```

3. [ ] Verify column creation
   ```sql
   SELECT column_name FROM information_schema.columns 
   WHERE table_name='data_agg_state' AND column_name IN ('agg_start_utc', 'enabled', 'task_priority');
   ```

4. [ ] Verify agg_start_utc values populated correctly
   ```sql
   SELECT canonical_symbol, timeframe, agg_start_utc, COUNT(*) FROM data_agg_state GROUP BY 1,2,3;
   ```

5. [ ] Run sync function
   ```sql
   SELECT sync_agg_state_from_registry();
   ```

6. [ ] Monitor aggregation logs for 1 hour
   - Check for errors in catchup_aggregation_range
   - Monitor cursor advancement
   - Check quality scores

### Post-Deployment (First 24 hours)

- [ ] Monitor aggregation lag < 1 hour for all tasks
- [ ] Check hard_fail_streak remains 0
- [ ] Verify cursor advancement in worker logs
- [ ] Check no increase in poor-quality bars
- [ ] Run monitoring queries every hour

---

## MONITORING QUERIES (Add to Dashboard)

```sql
-- 1. Aggregation Status Dashboard
SELECT 
  canonical_symbol,
  timeframe,
  status,
  enabled,
  last_agg_bar_ts_utc,
  NOW() - COALESCE(last_agg_bar_ts_utc, '1970-01-01'::timestamptz) as lag,
  last_successful_at_utc,
  hard_fail_streak,
  task_priority,
  agg_start_utc
FROM data_agg_state
WHERE enabled = true
ORDER BY canonical_symbol, timeframe;

-- 2. Alert Conditions
SELECT 
  canonical_symbol,
  timeframe,
  CASE 
    WHEN hard_fail_streak >= 3 THEN '🔴 CRITICAL: Auto-disabled'
    WHEN hard_fail_streak >= 2 THEN '🟠 WARNING: 2 consecutive failures'
    WHEN NOW() - last_successful_at_utc > interval '1 hour' THEN '🟡 ALERT: Lag > 1 hour'
    ELSE '✅ OK'
  END as status
FROM data_agg_state
WHERE enabled = true;

-- 3. Bar Quality
SELECT 
  canonical_symbol,
  timeframe,
  COUNT(*) as total_bars,
  COUNT(*) FILTER (WHERE quality_score >= 1) as good_bars,
  ROUND(100.0 * COUNT(*) FILTER (WHERE quality_score >= 1) / COUNT(*), 2) as quality_pct
FROM derived_data_bars
WHERE deleted_at IS NULL AND ts_utc >= NOW() - interval '24 hours'
GROUP BY canonical_symbol, timeframe
ORDER BY quality_pct ASC;
```

---

## NEXT STEPS

1. **Review this document** with platform team
2. **Address any clarifications** on corrected approach
3. **Run pre-deployment checks** to verify environment
4. **Generate SQL file** (011_aggregation_redesign.sql) from Part 2
5. **Test in dev environment** with rollback practiced
6. **Deploy to production** following checklist
7. **Monitor for 24 hours** before closing Phase 5

**Status**: Ready to code. All critical issues addressed and corrected.
