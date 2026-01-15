# PHASE 5: CRITICAL ISSUES & REQUIRED FIXES

**Status**: Pre-deployment review feedback  
**Action Required**: Address ALL critical issues before deployment  
**Generated**: 2026-01-13  
**Based on**: External code review + production verification

---

## EXECUTIVE SUMMARY

The Phase 5 implementation plan contains **12 identified issues**, of which **6 are CRITICAL** and must be fixed before deployment. The core fixes (UNION ALL removal, COALESCE) are correct, but **production-readiness gaps** exist in:

- Cursor semantics verification
- Rollback strategy
- Frontier detection robustness
- Transaction safety  
- Monitoring/alerting
- Hardcoded defaults

**Recommendation**: Do NOT deploy as-is. Address issues #1-6 (critical) before proceeding.

---

## ISSUE #1: CURSOR SEMANTICS - REQUIRES VERIFICATION ⚠️ CRITICAL

### Problem Statement

Document claims cursor semantics are correct:
```
✅ last_agg_bar_ts_utc = "start of the NEXT window to process"
```

But this needs **verification with actual data** because different interpretations exist:

```
Option A (Document's claim): cursor = next window start
  "2025-01-13 10:00:00" → process [10:00, 10:05) window next

Option B (Potential bug): cursor = last bar's timestamp  
  "2025-01-13 09:55:00" → we ALREADY processed [09:55, 10:00) window
```

### Verification Required

Run this query on production Supabase:

```sql
-- Compare cursor position to actual data
SELECT 
  das.canonical_symbol,
  das.timeframe,
  das.last_agg_bar_ts_utc as cursor_position,
  (SELECT MAX(ts_utc) FROM derived_data_bars 
   WHERE canonical_symbol = das.canonical_symbol 
   AND timeframe = das.timeframe 
   AND deleted_at IS NULL) as actual_last_bar_timestamp,
  CASE 
    WHEN das.last_agg_bar_ts_utc = 
         (SELECT MAX(ts_utc) FROM derived_data_bars 
          WHERE canonical_symbol = das.canonical_symbol 
          AND timeframe = das.timeframe AND deleted_at IS NULL)
      THEN '❌ WRONG: cursor = last bar (Option B)'
    WHEN das.last_agg_bar_ts_utc > 
         (SELECT MAX(ts_utc) FROM derived_data_bars 
          WHERE canonical_symbol = das.canonical_symbol 
          AND timeframe = das.timeframe AND deleted_at IS NULL)
      THEN '✅ CORRECT: cursor ahead of last bar (Option A)'
    ELSE '❓ UNKNOWN'
  END as interpretation
FROM data_agg_state das
WHERE das.canonical_symbol IN ('EURUSD', 'USDJPY')
  AND das.timeframe = '5m';
```

### If Option B is Found (WRONG)

If `cursor == actual_last_bar`, then:

```
Current logic in catchup:
  v_ws := v_cursor;               -- Window start = last bar's timestamp
  v_we := v_ws + interval;        -- Window end = last bar + 5min
  Process [last_bar, last_bar+5min) window
  ❌ PROBLEM: This window was ALREADY processed!
```

**Fix**: Adjust bootstrap and cursor advancement:

```sql
-- If cursor = last bar position, must advance to NEXT window start
SELECT agg_bootstrap_cursor(...)  -- Returns next window start
  INTO cursor_position
WHERE last_agg_bar_ts_utc IS NULL;

-- Or fix in catchup:
v_ws := v_cursor + interval '1 minute';  -- Skip to next window
```

### If Option A is Found (CORRECT)

Keep current implementation, document as verified.

### Action Items

- [ ] Run verification query on production
- [ ] Document actual cursor semantics with evidence
- [ ] If wrong, create fix immediately
- [ ] Add unit test to prevent regression

---

## ISSUE #2: SOURCE TABLE ARCHITECTURE - LOGIC GAP 🔴 CRITICAL

### Problem Statement

Current design assumes:
```
data_bars: timeframe = '1m' ONLY
derived_data_bars: timeframe = '5m', '1h', ...
```

**But what if a broker provides 5m bars directly?** (e.g., historical backfill, newer APIs, future assets)

### Current Design Breaks If

```sql
-- Scenario: API provides native 5m bars (not aggregated)
INSERT INTO data_bars (..., timeframe='5m', source='massive_api')
  ❌ Violates "1m only" constraint

INSERT INTO derived_data_bars (..., timeframe='5m', source='massive_api')  
  ❌ Semantically wrong (derived = computed, not ingested)
```

### Solution: Document Constraint Explicitly

Add this to schema and deployment docs:

```sql
-- ARCHITECTURAL CONSTRAINT: All ingested bars are 1m only
-- 
-- Why: Aggregation system assumes:
--   - data_bars contains all ingested timeframes (currently 1m)
--   - derived_data_bars contains all computed aggregations
--   - Bootstrap logic depends on source_timeframe = '1m'
--
-- If this changes:
--   1. Update agg_bootstrap_cursor() to check multiple source_tfs
--   2. Update catchup_aggregation_range() logic
--   3. Add new source config to data_agg_state
--
-- Current Assets (verified 2026-01-13):
--   - EURUSD: base_timeframe = 1m (API)
--   - XAUUSD: base_timeframe = 1m (API)
--   - DXY: base_timeframe = 1m (synthetic/calculated)
--
-- NO asset configured for base_timeframe = 5m or 1h
```

### Action Items

- [ ] Add constraint documentation to README
- [ ] Add pre-flight check: Verify all active assets have base_timeframe = '1m'
- [ ] Add to deployment runbook: "If adding new asset with 5m+ base_tf, contact platform team first"
- [ ] Create GitHub issue for future enhancement: "Support multi-timeframe ingestion"

---

## ISSUE #3: MISSING ROLLBACK SCRIPT 🔴 CRITICAL

### Problem Statement

Phase 5 adds 3 new columns but provides **NO rollback script**. If migration fails, you're stuck.

### What's Missing

```sql
-- Migration UP (provided)
ALTER TABLE data_agg_state
  ADD COLUMN agg_start_utc timestamptz DEFAULT '2025-07-01 00:00:00+00',
  ADD COLUMN enabled boolean DEFAULT true,
  ADD COLUMN task_priority integer DEFAULT 100;

-- Migration DOWN (missing!)
-- ❌ NOT PROVIDED - data loss risk
```

### Complete Rollback Script Required

```sql
-- 011_aggregation_redesign_ROLLBACK.sql

BEGIN;

-- 1. Drop indices on new columns
DROP INDEX IF EXISTS idx_data_agg_state_priority;
DROP INDEX IF EXISTS idx_data_agg_state_enabled_status;

-- 2. Remove new columns
ALTER TABLE data_agg_state
  DROP COLUMN IF EXISTS agg_start_utc CASCADE,
  DROP COLUMN IF EXISTS enabled CASCADE,
  DROP COLUMN IF EXISTS task_priority CASCADE;

-- 3. Drop new functions (if any)
DROP FUNCTION IF EXISTS sync_agg_state_from_registry() CASCADE;

-- 4. Restore old function signatures (if modified)
-- [Depends on what functions are changed in migration]

-- 5. Verify state
SELECT COUNT(*) as task_count FROM data_agg_state;

COMMIT;
```

### Action Items

- [ ] Create 011_aggregation_redesign_ROLLBACK.sql
- [ ] Test rollback in dev environment
- [ ] Create runbook: "How to rollback Phase 5 if it fails"
- [ ] Document rollback approval process

---

## ISSUE #4: HARDCODED agg_start_utc DEFAULT 🔴 CRITICAL

### Problem Statement

```sql
ADD COLUMN agg_start_utc timestamptz 
  NOT NULL DEFAULT '2025-07-01 00:00:00+00'
```

**Problems:**
- Hardcoded date in schema (unmaintainable)
- Same for all assets (wrong if they have different data availability)
- No explanation for why 2025-07-01

**What if:**
- DXY has data from 2020-01-01?
- EURUSD from 2015?
- New asset added next week starts 2026-01-14?

### Current Behavior (Breaks Backfill)

```
Example: EURUSD has 1m data from 2015-01-01 onwards
         Phase 5 adds agg_start_utc = 2025-07-01

Result: 
  - Aggregator never processes bars before 2025-07-01
  - 10 years of data left unaggregated
  - Gap between historical data and live aggregation
```

### Solution: Per-Asset Configuration

**Option A (Recommended): Calculate from actual data**

```sql
-- Phase 5 Migration approach:
ALTER TABLE data_agg_state
  ADD COLUMN agg_start_utc timestamptz NULL;  -- No default

-- Populate from actual data
UPDATE data_agg_state
SET agg_start_utc = (
  SELECT COALESCE(
    MIN(ts_utc),  -- Earliest 1m bar for this asset
    '2025-07-01'  -- Fallback if no data yet
  )
  FROM data_bars
  WHERE canonical_symbol = data_agg_state.canonical_symbol
    AND timeframe = '1m'
);

-- Add constraint after population
ALTER TABLE data_agg_state
  ALTER COLUMN agg_start_utc SET NOT NULL;
```

**Option B (Future): Registry-driven**

```sql
-- In core_asset_registry_all, add metadata:
UPDATE core_asset_registry_all
SET metadata = COALESCE(metadata, '{}'::jsonb) || 
  jsonb_build_object(
    'aggregation', jsonb_build_object(
      'start_date_utc', '2020-01-01',
      'earliest_available_1m', '2020-01-01',
      'mandatory_timeframes', '["5m", "1h"]'
    )
  )
WHERE canonical_symbol = 'EURUSD';

-- Then use in aggregation:
SELECT (metadata->'aggregation'->>'start_date_utc')::timestamptz
FROM core_asset_registry_all
WHERE canonical_symbol = 'EURUSD';
```

### Action Items

- [ ] Change default from hardcoded date to NULL
- [ ] Add migration step: Calculate per-asset from actual data
- [ ] Document why each asset has its agg_start_utc value
- [ ] Create monitoring: Alert if agg_start_utc is after earliest 1m bar

---

## ISSUE #5: FRONTIER DETECTION IS FRAGILE 🔴 CRITICAL

### Problem Statement

Current logic:
```sql
IF v_source_count = 0 THEN
  EXIT;  -- Stop processing immediately
END IF;
```

**This breaks in real-world scenarios:**

### Scenario A: Partial Day Ingestion (REAL)

```
Market hours: 10:00-18:00 (8 hours)
1m bars exist: 10:00 - 14:35 (4.5 hours)
Aggregator processes 5m windows:
  - 14:30-14:35: source_count=1 (partial, stored as quality=0)
  - 14:35-14:40: source_count=0 ← STOPS HERE

Later (15:00):
  New 1m bars arrive: 14:40 onwards
  
Problem:
  - Cursor stuck at 14:35
  - New bars never aggregated
  - Manual intervention required
```

### Scenario B: Data Gap / Broker Outage (REAL)

```
1m bars exist: 10:00-12:00, [GAP from broker], 14:00-18:00
Aggregator:
  - Processes 10:00-12:00 successfully
  - Hits gap at 12:00-12:05: source_count=0 ← STOPS
  
Problem:
  - Never processes 14:00-18:00 bars
  - Data loss from user perspective
```

### Scenario C: Delayed Ingestion (REAL)

```
Aggregator polling every 5 minutes:
  - 15:05: All bars present up to 15:00
  - 15:10: Broker delayed, 1m bar for 15:05 not yet available
  - Aggregation runs, sees source_count=0 at 15:05-15:10 → STOPS
  - 15:12: Broker sends missing bar
  - 15:15: Run again, but cursor still at 15:05

Better: Allow 1-2 gaps before stopping
```

### Solution: Allow Controlled Gaps

```sql
-- Track consecutive windows with no source data
v_zero_source_streak := 0;
v_max_zeros_before_stop := 3;  -- Allow 3 empty windows (15 minutes)

WHILE v_processed < p_max_windows LOOP
  -- ... aggregation logic ...
  
  IF v_source_count = 0 THEN
    v_zero_source_streak := v_zero_source_streak + 1;
    
    -- Only stop if we've seen many consecutive gaps
    IF v_zero_source_streak >= v_max_zeros_before_stop THEN
      EXIT;  -- Reached frontier
    END IF;
  ELSE
    -- Reset counter when we find data
    v_zero_source_streak := 0;
  END IF;
  
  -- Always advance cursor (even if no data)
  v_cursor := v_we;
  v_processed := v_processed + 1;
END LOOP;
```

### Alternative: Use Confirmation Time

```sql
-- Stop only if no data AND past confirmation time
v_confirm := v_we + (v_delay_sec || ' seconds')::interval;

IF v_source_count = 0 AND v_now >= v_confirm THEN
  -- No data AND we've waited past confirmation = frontier reached
  EXIT;
ELSIF v_source_count = 0 AND v_now < v_confirm THEN
  -- No data yet, but too early to give up
  v_cursor := v_we;
  v_processed := v_processed + 1;
  CONTINUE;
END IF;
```

### Action Items

- [ ] Implement gap tolerance logic (min 3 windows)
- [ ] Add monitoring: Alert on cursor lag > expected
- [ ] Document expected frontier behavior
- [ ] Test with simulated data outages

---

## ISSUE #6: NO TRANSACTION SAFETY 🔴 CRITICAL

### Problem Statement

Functions execute multiple steps without transaction control:

```sql
CREATE OR REPLACE FUNCTION aggregate_1m_to_5m_window(...)
AS $$
BEGIN
  -- 1. Query source data (1m bars)
  SELECT ... INTO v_bars ...;
  
  -- 2. Compute aggregation
  v_open := v_bars[1].open;
  v_high := MAX(v_bars[*].high);
  ...
  
  -- 3. Upsert to derived_data_bars
  PERFORM _upsert_derived_bar(...);
  
  -- ❌ No transaction control
  -- What if step 3 fails? Steps 1-2 already executed.
  -- What if connection lost between 2 and 3?
END;
```

### Risks

- Partial inserts (aggregation computed but not stored)
- Inconsistent state if function fails mid-execution
- No rollback if external service call fails
- Race conditions with concurrent tasks

### Solution: Add Transaction Safety

```sql
CREATE OR REPLACE FUNCTION aggregate_1m_to_5m_window(...)
RETURNS jsonb AS $$
DECLARE
  v_bars RECORD[];
  v_result jsonb;
BEGIN
  -- Set transaction isolation level
  SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
  
  BEGIN
    -- 1. Query source data
    SELECT array_agg(row(...)) INTO v_bars
    FROM data_bars
    WHERE canonical_symbol = p_symbol
      AND timeframe = '1m'
      AND ts_utc >= p_from_utc
      AND ts_utc < p_to_utc;
    
    IF array_length(v_bars, 1) IS NULL OR array_length(v_bars, 1) = 0 THEN
      RETURN jsonb_build_object(
        'success', true,
        'stored', false,
        'source_count', 0,
        'reason', 'insufficient_source_bars'
      );
    END IF;
    
    -- 2. Compute aggregation (no DB writes yet)
    v_open := (v_bars[1]).open;
    v_high := (SELECT MAX(v.high) FROM UNNEST(v_bars) v);
    ...
    
    -- 3. Upsert (wrapped in transaction)
    v_result := _upsert_derived_bar(
      p_symbol, p_tf, p_from_utc,
      v_open, v_high, v_low, v_close, v_vol, v_vwap, v_trade_count,
      'agg', '1m', array_length(v_bars, 1), 5,
      CASE 
        WHEN array_length(v_bars, 1) >= 5 THEN 2
        WHEN array_length(v_bars, 1) = 4 THEN 1
        ELSE 0
      END,
      p_derivation_version,
      jsonb_build_object('source_count', array_length(v_bars, 1))
    );
    
    RETURN jsonb_build_object(
      'success', true,
      'stored', v_result->>'success'::boolean,
      'source_count', array_length(v_bars, 1),
      'quality_score', CASE 
        WHEN array_length(v_bars, 1) >= 5 THEN 2
        WHEN array_length(v_bars, 1) = 4 THEN 1
        ELSE 0
      END
    );
    
  EXCEPTION WHEN OTHERS THEN
    -- Log error and return failure
    RAISE WARNING 'aggregate_1m_to_5m_window failed: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM,
      'error_code', SQLSTATE
    );
  END;

END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### Action Items

- [ ] Add explicit transaction control to all aggregation functions
- [ ] Add EXCEPTION handlers with logging
- [ ] Test failure scenarios (e.g., unique constraint violations)
- [ ] Document expected error responses

---

## ISSUE #7: NO PERFORMANCE BENCHMARKS ⚠️ HIGH

### Problem Statement

Document claims removing UNION ALL improves performance but provides **zero evidence**.

### Missing Benchmarks

```sql
-- Benchmark 1: Old approach (with UNION ALL)
-- Required to measure against

-- Benchmark 2: New approach (conditional logic)
EXPLAIN ANALYZE
SELECT MAX(ts_utc) INTO v_latest
FROM data_bars
WHERE canonical_symbol = 'EURUSD' AND timeframe = '1m';

EXPLAIN ANALYZE
SELECT MAX(ts_utc) INTO v_latest  
FROM derived_data_bars
WHERE canonical_symbol = 'EURUSD' AND timeframe = '5m' AND deleted_at IS NULL;
```

### Action Items

- [ ] Run EXPLAIN ANALYZE for old vs new approach
- [ ] Document query plans
- [ ] Add performance requirements to docs: "Bootstrap must complete in < 100ms"
- [ ] Add regression test to CI/CD

---

## ISSUE #8: RACE CONDITION IN sync_agg_state_from_registry 🔴 CRITICAL

### Problem Statement

Proposed sync function has race condition:

```sql
-- Step 1: Insert/update tasks for active assets
INSERT INTO data_agg_state (canonical_symbol, timeframe, ...)
  SELECT das.canonical_symbol, '5m', ...
  FROM core_asset_registry_all car
  LEFT JOIN data_agg_state das ON car.canonical_symbol = das.canonical_symbol 
                                   AND das.timeframe = '5m'
  WHERE car.active = true
ON CONFLICT DO UPDATE ...;

-- Step 2: Disable tasks for inactive assets (runs later)
UPDATE data_agg_state
SET enabled = false
WHERE canonical_symbol NOT IN (
  SELECT canonical_symbol FROM core_asset_registry_all WHERE active = true
);
```

### Race Scenario

```
T0: Asset XYZ is active=true
T1: Step 1 runs → creates task for XYZ (enabled=true)
T2: Asset XYZ is deactivated (concurrent transaction)
T3: Step 2 runs → queries active assets, XYZ not in list
T4: Task for XYZ remains enabled (should be disabled)

Result: Stale aggregation task runs for inactive asset
```

### Solution: Atomic CTE

```sql
CREATE OR REPLACE FUNCTION sync_agg_state_from_registry()
RETURNS jsonb AS $$
DECLARE
  v_created INT := 0;
  v_disabled INT := 0;
  v_result jsonb;
BEGIN
  
  -- Single atomic operation using CTE
  WITH active_assets AS (
    SELECT canonical_symbol, timeframe
    FROM (
      SELECT DISTINCT 
        car.canonical_symbol,
        (VALUES ('5m'), ('1h')) AS t(timeframe)
      FROM core_asset_registry_all car
      WHERE car.active = true
    ) tf_cartesian
    FOR UPDATE OF core_asset_registry_all  -- Lock registry rows
  ),
  upsert_tasks AS (
    INSERT INTO data_agg_state (
      canonical_symbol, timeframe, 
      source_timeframe, run_interval_minutes, 
      aggregation_delay_seconds, is_mandatory, enabled
    )
    SELECT 
      aa.canonical_symbol, aa.timeframe,
      '1m', 
      CASE WHEN aa.timeframe = '5m' THEN 5 ELSE 60 END,
      30,
      true, true
    FROM active_assets aa
    ON CONFLICT (canonical_symbol, timeframe)
    DO UPDATE SET enabled = true, updated_at = NOW()
    RETURNING canonical_symbol, timeframe, 'inserted'::text as action
  ),
  disable_orphans AS (
    UPDATE data_agg_state das
    SET enabled = false, updated_at = NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM core_asset_registry_all car
      WHERE car.canonical_symbol = das.canonical_symbol
        AND car.active = true
    )
    RETURNING canonical_symbol, timeframe, 'disabled'::text as action
  )
  SELECT jsonb_build_object(
    'success', true,
    'tasks_created_or_updated', (SELECT COUNT(*) FROM upsert_tasks),
    'tasks_disabled', (SELECT COUNT(*) FROM disable_orphans),
    'timestamp', NOW()
  ) INTO v_result;
  
  RETURN v_result;
  
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', false,
    'error', SQLERRM
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### Action Items

- [ ] Implement atomic CTE version
- [ ] Test concurrent registry updates
- [ ] Add documentation: "sync_agg_state_from_registry must be called in exclusive mode"

---

## ISSUE #9: NULLIF vs COALESCE Bug Explanation 🟡 MEDIUM

### Current State

Document correctly identifies bug:
```sql
-- ❌ Old (buggy):
v_source_rows := NULLIF((v_res->>'source_count')::int, NULL);

-- ✅ Fixed:
v_source_rows := COALESCE((v_res->>'source_count')::int, 0);
```

### Problem with Current Explanation

Document doesn't explain **why** this was a bug. Readers think:
```sql
NULLIF(5, NULL) → 5  -- This works fine
NULLIF(NULL, NULL) → NULL -- Same as input
-- What's the issue?
```

### Root Cause Clarified

```sql
-- The bug: JSON integer extraction can fail
v_res->>'source_count'  -- Returns text (e.g., "5" or NULL)
(v_res->>'source_count')::int  -- Casts to integer

-- If JSON field missing:
(NULL::text)::int  -- ❌ ERROR: invalid input syntax for integer

-- NULLIF doesn't help:
NULLIF((NULL::text)::int, NULL) -- Error happens BEFORE NULLIF

-- COALESCE with safer casting:
COALESCE(
  CASE WHEN v_res->>'source_count' IS NOT NULL 
    THEN (v_res->>'source_count')::int 
    ELSE NULL 
  END, 
  0
) -- ✅ Handles NULL before casting
```

### Corrected Fix

```sql
-- Better: Handle NULL before casting
v_source_rows := COALESCE(
  (v_res->>'source_count')::int,  -- Will be NULL if key missing
  0  -- Default to 0 if not present
);

-- Or explicitly safe:
v_source_rows := CASE 
  WHEN v_res->>'source_count' IS NOT NULL
    THEN (v_res->>'source_count')::int
  ELSE 0
END;

-- Or use jsonb_extract_path for safety:
v_source_rows := COALESCE(
  (v_res->'source_count')::text::int,  -- jsonb integer has type info
  0
);
```

### Action Items

- [ ] Update documentation with root cause explanation
- [ ] Use safer casting in actual functions
- [ ] Add unit test for missing JSON fields

---

## ISSUE #10: QUALITY SCORE LOGIC TOO SIMPLE ⚠️ HIGH

### Problem Statement

Current logic doesn't account for **which bars are missing**:

```sql
IF v_cnt >= 5 THEN v_q := 2;      -- Excellent (any 5 bars)
ELSIF v_cnt = 4 THEN v_q := 1;    -- Good (any 4 bars)
ELSIF v_cnt = 3 THEN v_q := 0;    -- Poor (any 3 bars)
ELSE RETURN 'insufficient';       -- Skip
```

### Problem Scenario

```
Window: 10:00-10:05 (need 1m bars at 10:00, 10:01, 10:02, 10:03, 10:04)

Case A: Missing 10:02 (middle bar)
  Bars: [10:00, 10:01, 10:03, 10:04]
  Close: 10:04 close ✅ Correct
  Quality = 1 (4/5)

Case B: Missing 10:04 (last bar)
  Bars: [10:00, 10:01, 10:02, 10:03]
  Close: 10:03 close ❌ Wrong! (stale by 1 minute)
  Quality = 1 (4/5) -- Same as Case A, but worse!
```

### Better Approach

```sql
-- Check if final bar exists (critical for close price)
v_has_final_bar := EXISTS(
  SELECT 1 FROM v_bars 
  WHERE ts_utc = v_we - interval '1 minute'
);

v_quality := CASE
  WHEN v_cnt >= 5 THEN 2  -- All bars
  WHEN v_cnt = 4 AND v_has_final_bar THEN 1  -- Missing bar but have close
  WHEN v_cnt = 4 AND NOT v_has_final_bar THEN 0  -- Missing final bar
  WHEN v_cnt = 3 AND v_has_final_bar THEN 0  -- Sparse but have close
  WHEN v_cnt = 3 AND NOT v_has_final_bar THEN -1  -- Sparse AND no close
  ELSE NULL  -- Skip
END;

-- Alternative: Use volume/count weighting
v_quality := ROUND(
  (v_cnt::float / 5.0) * 2,  -- Scale count to -2 to 2
  0
)::int;
-- Result: 5 bars → 2, 4 bars → 1.6→2, 3 bars → 1.2→1, 2 bars → 0.8→1, etc.
```

### Action Items

- [ ] Improve quality scoring logic
- [ ] Document quality score interpretation
- [ ] Add monitoring: Alert on high % of quality=0 bars

---

## ISSUE #11: MISSING MONITORING GUIDANCE ⚠️ MEDIUM

### Required Monitoring Queries

Add these to operational runbook:

```sql
-- 1. Aggregation lag per asset
SELECT 
  canonical_symbol,
  timeframe,
  NOW() - COALESCE(last_agg_bar_ts_utc, '1970-01-01') as lag,
  status,
  last_successful_at_utc,
  hard_fail_streak
FROM data_agg_state
WHERE enabled = true
ORDER BY lag DESC;

-- 2. Task failure rate
SELECT 
  COUNT(*) as total_tasks,
  COUNT(*) FILTER (WHERE hard_fail_streak > 0) as failing_tasks,
  COUNT(*) FILTER (WHERE hard_fail_streak >= 3) as disabled_tasks,
  ROUND(100.0 * COUNT(*) FILTER (WHERE hard_fail_streak > 0) / COUNT(*), 2) as failure_rate_pct
FROM data_agg_state
WHERE enabled = true;

-- 3. Bar coverage
SELECT 
  ddb.canonical_symbol,
  ddb.timeframe,
  COUNT(*) as total_bars,
  COUNT(*) FILTER (WHERE quality_score >= 1) as good_bars,
  COUNT(*) FILTER (WHERE quality_score <= 0) as poor_bars,
  ROUND(100.0 * COUNT(*) FILTER (WHERE quality_score >= 1) / COUNT(*), 2) as quality_pct
FROM derived_data_bars ddb
WHERE deleted_at IS NULL
  AND ddb.ts_utc >= NOW() - interval '7 days'
GROUP BY ddb.canonical_symbol, ddb.timeframe
ORDER BY quality_pct ASC;

-- 4. Frontier detection
SELECT 
  canonical_symbol,
  timeframe,
  last_agg_bar_ts_utc as cursor_position,
  (SELECT MAX(ts_utc) FROM data_bars 
   WHERE canonical_symbol = das.canonical_symbol AND timeframe = '1m') as source_max,
  (SELECT MAX(ts_utc) FROM data_bars 
   WHERE canonical_symbol = das.canonical_symbol AND timeframe = '1m') 
   - last_agg_bar_ts_utc as gap_duration
FROM data_agg_state das
WHERE enabled = true AND timeframe = '5m'
ORDER BY gap_duration DESC;
```

### Action Items

- [ ] Add these queries to monitoring dashboard
- [ ] Set up alerts:
  - Lag > 1 hour for mandatory tasks
  - Failure rate > 10%
  - Poor quality bars > 5%
- [ ] Create incident response runbook

---

## ISSUE #12: NO EDGE CASE DOCUMENTATION ⚠️ MEDIUM

### Missing Documentation

Add to deployment docs:

```markdown
## Known Edge Cases & Limitations

### Daylight Saving Time (DST)

**Case**: Europe transitions from CET (UTC+1) to CEST (UTC+2) at 2AM

**Scenario**:
- 1m bars arrive with ts_utc in UTC (always consistent)
- Europe local time jumps from 02:00 to 03:00
- Aggregator doesn't care (works in UTC) ✅

**What works**:
- All ts_utc in UTC, no ambiguity
- Window boundaries align to UTC

**What could break**:
- If client code uses local timestamps without conversion
- If broker sends DST-adjusted timestamps

### Data Arriving Out-of-Order

**Case**: Broker delays, then sends batch of 1m bars

**Scenario**:
- 14:00-14:05: 1m bars arrive
- Aggregation processes, stores 5m bar @ 14:05
- 14:06: Delayed 1m bar for 14:00-14:01 arrives
- Aggregation window [14:00-14:05) now has 6 bars!

**Current behavior**:
- ON CONFLICT ... DO UPDATE rewrites bar (idempotent) ✅
- No cascading to higher timeframes ✅

**Risk**:
- Quality score could change retroactively
- If monitoring uses historical snapshots, appears inconsistent

### Leap Seconds

**Current approach**: PostgreSQL ignores leap seconds
- 23:59:60 seconds inserted as 23:59:59
- No issues expected ✅

### Concurrent Aggregation of Same Asset

**Case**: Multiple workers run simultaneously for same asset

**Current protection**:
- status = 'running' prevents concurrent claims
- Soft lock, not distributed lock
- If worker crashes, task stuck in 'running'

**Recommendation**:
- Add timeout: If status='running' AND running_started_at_utc > 30 min old → reset to idle
- Add heartbeat: Workers update running_started_at_utc every 5 seconds
```

### Action Items

- [ ] Create edge_cases.md documentation
- [ ] Add unit tests for DST transitions
- [ ] Test out-of-order bar handling
- [ ] Implement heartbeat/timeout logic for soft lock

---

## SUMMARY TABLE: Issues & Status

| Issue | Severity | Status | Action Required | Estimated Fix Time |
|-------|----------|--------|-----------------|-------------------|
| #1: Cursor semantics | 🔴 CRITICAL | Unverified | Verify with query | 30 min |
| #2: Source table constraint | 🔴 CRITICAL | Design gap | Document constraint | 1 hour |
| #3: Missing rollback script | 🔴 CRITICAL | Not provided | Create & test rollback | 2 hours |
| #4: Hardcoded agg_start_utc | 🔴 CRITICAL | Wrong approach | Calculate per-asset | 1 hour |
| #5: Frontier detection fragile | 🔴 CRITICAL | Breaks in real scenarios | Implement gap tolerance | 2 hours |
| #6: No transaction safety | 🔴 CRITICAL | Missing | Add EXCEPTION handlers | 1.5 hours |
| #7: No performance benchmarks | 🟡 HIGH | Missing | Run EXPLAIN ANALYZE | 1 hour |
| #8: Race condition in sync | 🔴 CRITICAL | Design flaw | Use atomic CTE | 1.5 hours |
| #9: NULLIF explanation incomplete | 🟡 MEDIUM | Documentation | Update docs | 30 min |
| #10: Quality score logic | 🟡 MEDIUM | Too simple | Improve logic | 1.5 hours |
| #11: No monitoring guidance | 🟡 MEDIUM | Missing | Create dashboard queries | 1 hour |
| #12: Edge cases not documented | 🟡 MEDIUM | Missing | Add documentation | 1 hour |

**Total Time to Fix CRITICAL Issues**: ~11 hours  
**Total Time to Fix ALL Issues**: ~15 hours

---

## RECOMMENDED DEPLOYMENT SEQUENCE

### Phase 5a: Pre-Deployment Fixes (Must complete before coding Phase 5)

- [ ] Issue #1: Verify cursor semantics with DB query
- [ ] Issue #2: Document source table constraint
- [ ] Issue #4: Recalculate agg_start_utc per-asset approach
- [ ] Issue #5: Implement gap tolerance in frontier detection
- [ ] Issue #8: Redesign sync function with atomic CTE

### Phase 5b: Core Implementation (Uses Phase 5a fixes)

- [ ] Add 3 new columns to data_agg_state (with corrected agg_start_utc)
- [ ] Update agg_bootstrap_cursor() with conditional source logic
- [ ] Update catchup_aggregation_range() with gap tolerance and agg_start_utc enforcement
- [ ] Create sync_agg_state_from_registry() with atomic CTE
- [ ] Update agg_get_due_tasks() ordering

### Phase 5c: Safety & Testing (Before production)

- [ ] Issue #3: Create & test rollback script
- [ ] Issue #6: Add transaction safety to all functions
- [ ] Issue #7: Run performance benchmarks
- [ ] Issue #9: Improve NULLIF/COALESCE logic
- [ ] Issue #10: Enhance quality score calculation
- [ ] Issue #11: Set up monitoring queries
- [ ] Issue #12: Document edge cases

### Phase 5d: Deployment

- [ ] Deploy migration SQL
- [ ] Verify: All tasks have agg_start_utc set
- [ ] Verify: No errors in aggregation logs
- [ ] Monitor: Aggregation lag < 1 hour
- [ ] Monitor: No increase in hard_fail_streak

---

## DO NOT DEPLOY without addressing ALL 6 CRITICAL ISSUES (#1-6, #8)

**Current Verdict**: 7/10 overall quality. Production-readiness gaps must be fixed.

**Next Step**: Create corrected Phase 5 implementation with all issues resolved.
