# DXY Migration - Aggregation System Review

**Date**: 2026-01-13  
**Status**: Pre-Test Phase Review  
**Purpose**: Review all aggregation components before testing Phase 5 changes

---

## Executive Summary

### What Changed
- **DXY 1m data location**: Moved from `derived_data_bars` → `data_bars`
- **Aggregation functions**: Need to update `aggregate_1m_to_5m_window` to remove UNION ALL for 1m source
- **Impact**: Simplifies queries, improves performance, reduces semantic confusion

### Current State
- ✅ Phase 1-4 Complete: 11,839 DXY bars regenerated in `data_bars`
- ⚠️ Phase 5 Pending: Aggregation functions not yet updated
- 🔍 This Review: Understand system before applying changes

---

## 1. Architecture Overview

### Data Flow (Current Production)

```
FX Components (EURUSD, USDJPY, etc.)
    ↓ (ingested to data_bars)
calc_dxy_range_derived() function
    ↓ (calculates DXY from FX)
derived_data_bars (DXY 1m with source='dxy')
    ↓ (UNION ALL query)
aggregate_1m_to_5m_window()
    ↓
derived_data_bars (DXY 5m with source='agg')
    ↓
aggregate_5m_to_1h_window()
    ↓
derived_data_bars (DXY 1h with source='agg')
```

### Data Flow (After Migration)

```
FX Components (EURUSD, USDJPY, etc.)
    ↓ (ingested to data_bars)
calc_dxy_range_1m() function [NEW]
    ↓ (calculates DXY from FX)
data_bars (DXY 1m with source='synthetic') [NEW LOCATION]
    ↓ (NO UNION ALL - single table)
aggregate_1m_to_5m_window() [UPDATED]
    ↓
derived_data_bars (DXY 5m with source='agg')
    ↓
aggregate_5m_to_1h_window() [NO CHANGE]
    ↓
derived_data_bars (DXY 1h with source='agg')
```

---

## 2. Core Components

### 2.1 Database Tables

#### `data_bars` (Raw Market Data + DXY 1m)
```sql
CREATE TABLE data_bars (
  id bigserial PRIMARY KEY,
  canonical_symbol text NOT NULL,
  timeframe text NOT NULL,
  ts_utc timestamptz NOT NULL,
  
  open double precision,
  high double precision,
  low double precision,
  close double precision,
  vol double precision,
  vwap double precision,
  trade_count integer,
  
  is_partial boolean,
  source text,  -- 'massive_api', 'ingest', 'synthetic' (for DXY)
  ingested_at timestamptz,
  raw jsonb,
  
  UNIQUE(canonical_symbol, timeframe, ts_utc)
);
```

**Current Data**:
- Regular FX pairs (EURUSD, etc.): ~12,000 bars each
- **DXY 1m**: 11,839 bars (newly migrated, source='synthetic')

#### `derived_data_bars` (Aggregated + Legacy DXY)
```sql
CREATE TABLE derived_data_bars (
  id bigserial PRIMARY KEY,
  canonical_symbol text NOT NULL,
  timeframe text NOT NULL,
  ts_utc timestamptz NOT NULL,
  
  open/high/low/close double precision,
  vol, vwap, trade_count,
  
  is_partial boolean DEFAULT false,
  source text DEFAULT 'agg',  -- 'agg', 'dxy' (legacy)
  
  source_timeframe text,       -- '1m' or '5m'
  source_candles integer,      -- How many source bars used
  expected_candles integer,    -- How many expected
  quality_score integer,       -- 0=poor, 1=good, 2=excellent
  
  derivation_version integer,
  deleted_at timestamptz,      -- Soft delete
  
  UNIQUE(canonical_symbol, timeframe, ts_utc) WHERE deleted_at IS NULL
);
```

**Current Data**:
- **DXY 1m** (legacy): 4,666 bars (source='dxy') - TO BE CLEANED UP
- **DXY 5m**: XX bars (source='agg')
- **DXY 1h**: XX bars (source='agg')
- All other aggregated data (EURUSD 5m/1h, etc.)

#### `data_agg_state` (Task Configuration)
```sql
CREATE TABLE data_agg_state (
  canonical_symbol text,
  timeframe text,                    -- Target timeframe (5m, 1h)
  source_timeframe text,             -- Source timeframe (1m, 5m)
  
  run_interval_minutes integer,      -- How often to run (5, 60)
  aggregation_delay_seconds integer, -- Wait time (300 = 5min)
  
  last_agg_bar_ts_utc timestamptz,  -- Cursor position
  status text DEFAULT 'idle',        -- idle|running|disabled
  next_run_at timestamptz,
  
  is_mandatory boolean DEFAULT false,
  hard_fail_streak integer DEFAULT 0,
  
  total_runs bigint DEFAULT 0,
  total_bars_created bigint DEFAULT 0,
  
  PRIMARY KEY (canonical_symbol, timeframe)
);
```

**DXY Configuration**:
```sql
-- DXY 5m (from 1m source)
INSERT INTO data_agg_state VALUES (
  'DXY', '5m', '1m',  -- symbol, target_tf, source_tf
  5, 300,              -- run every 5min, 5min delay
  ..., 'idle', ...
);

-- DXY 1h (from 5m source)
INSERT INTO data_agg_state VALUES (
  'DXY', '1h', '5m',   -- symbol, target_tf, source_tf
  60, 300,             -- run every 60min, 5min delay
  ..., 'idle', ...
);
```

---

## 3. SQL Functions (Production)

### 3.1 `aggregate_1m_to_5m_window()` - NEEDS UPDATE

**Current Implementation** (lines 430-470 in aggregatorsql):
```sql
CREATE OR REPLACE FUNCTION aggregate_1m_to_5m_window(
  p_symbol text,
  p_from_utc timestamptz,
  p_to_utc timestamptz,
  p_derivation_version int DEFAULT 1
)
RETURNS jsonb AS $$
DECLARE
  v_cnt int; v_o/h/l/c/vol/vwap/tc ...;
BEGIN
  WITH src AS (
    -- ⚠️ UNION ALL - reads from both tables
    SELECT ts_utc,open,high,low,close,vol,vwap,trade_count 
    FROM data_bars
    WHERE canonical_symbol=p_symbol AND timeframe='1m' 
      AND ts_utc>=p_from_utc AND ts_utc<p_to_utc
    
    UNION ALL
    
    SELECT ts_utc,open,high,low,close,vol,vwap,trade_count 
    FROM derived_data_bars
    WHERE canonical_symbol=p_symbol AND timeframe='1m' 
      AND deleted_at IS NULL
      AND ts_utc>=p_from_utc AND ts_utc<p_to_utc
  ),
  agg AS (
    -- Aggregate: first open, last close, max high, min low
    SELECT COUNT(*) cnt, ... FROM src
  )
  
  -- Quality scoring
  IF v_cnt>=5 THEN v_q:=2;      -- Excellent
  ELSIF v_cnt=4 THEN v_q:=1;    -- Good
  ELSIF v_cnt=3 THEN v_q:=0;    -- Poor
  ELSE RETURN insufficient_source_bars;
  END IF;
  
  -- Upsert to derived_data_bars
  PERFORM _upsert_derived_bar(...);
  
  RETURN jsonb_build_object(
    'success', true,
    'stored', true,
    'source_count', v_cnt,
    'quality_score', v_q
  );
END $$;
```

**What It Does**:
1. Reads 1m bars from BOTH tables (data_bars + derived_data_bars)
2. Aggregates 5 consecutive 1m bars into one 5m bar
3. Stores result in `derived_data_bars` with source='agg'

**Why UNION ALL Was Needed**:
- DXY 1m was in `derived_data_bars`
- Regular FX pairs were in `data_bars`
- Needed to query both to get all 1m data

**After Migration**:
- ✅ All 1m data (including DXY) now in `data_bars`
- ❌ UNION ALL no longer needed
- ✅ Single table query = simpler + faster

### 3.2 `aggregate_5m_to_1h_window()` - NO CHANGE NEEDED

**Current Implementation** (lines 475-520 in aggregatorsql):
```sql
CREATE OR REPLACE FUNCTION aggregate_5m_to_1h_window(...)
RETURNS jsonb AS $$
BEGIN
  WITH src AS (
    -- Only queries derived_data_bars (5m data location)
    SELECT ts_utc,open,high,low,close,vol,vwap,trade_count
    FROM derived_data_bars
    WHERE canonical_symbol=p_symbol AND timeframe='5m' 
      AND deleted_at IS NULL
      AND ts_utc>=p_from_utc AND ts_utc<p_to_utc
  ),
  agg AS (
    SELECT COUNT(*) cnt, ... FROM src
  )
  
  -- Quality: 12=>excellent, 10-11=>good, 8-9=>poor, 7=>very poor
  -- Stores if count >= 7
  ...
END $$;
```

**Why No Change**:
- 5m bars are STILL in `derived_data_bars`
- No UNION ALL needed (single source table)
- This function works correctly as-is

### 3.3 `catchup_aggregation_range()` - NEEDS UPDATE

**Current Implementation** (lines 620-680 in aggregatorsql):
```sql
CREATE OR REPLACE FUNCTION catchup_aggregation_range(
  p_symbol text,
  p_to_tf text,                -- '5m' or '1h'
  p_start_cursor_utc timestamptz,
  p_max_windows integer DEFAULT 100,
  ...
)
RETURNS jsonb AS $$
DECLARE
  v_cursor timestamptz;
  v_max_source_ts timestamptz;
  v_src_tf text;
BEGIN
  -- Get config
  SELECT run_interval_minutes, source_timeframe 
  INTO v_interval_min, v_src_tf
  FROM data_agg_state 
  WHERE canonical_symbol=p_symbol AND timeframe=p_to_tf;
  
  -- Safety check: get max available source timestamp
  -- ⚠️ Uses UNION ALL to check both tables
  SELECT MAX(ts_utc) INTO v_max_source_ts
  FROM (
    SELECT ts_utc FROM data_bars 
      WHERE canonical_symbol=p_symbol AND timeframe=v_src_tf
    UNION ALL
    SELECT ts_utc FROM derived_data_bars 
      WHERE canonical_symbol=p_symbol AND timeframe=v_src_tf AND deleted_at IS NULL
  ) x;
  
  -- Process windows
  WHILE v_processed < p_max_windows LOOP
    IF p_to_tf='5m' THEN
      v_res := aggregate_1m_to_5m_window(...);  -- Calls the function
    ELSIF p_to_tf='1h' THEN
      v_res := aggregate_5m_to_1h_window(...);
    END IF;
    
    -- Check if we have source data
    v_source_rows := (v_res->>'source_count')::int;
    IF v_source_rows = 0 THEN EXIT; END IF;  -- Stop at data frontier
    
    v_cursor := v_we;  -- Advance cursor
  END LOOP;
  
  RETURN jsonb_build_object(...);
END $$;
```

**What It Does**:
1. Checks max available source data timestamp (to avoid processing empty windows)
2. Loops through time windows, calling appropriate aggregation function
3. Advances cursor as windows are processed
4. Returns summary (windows processed, bars created, etc.)

**Why It Needs Update**:
- The max source timestamp check uses UNION ALL
- For 1m source (5m aggregation), should only check `data_bars`
- For 5m source (1h aggregation), still needs UNION ALL

### 3.4 `calc_dxy_range_derived()` - LEGACY (Not Updated)

**Current Implementation** (lines 530-600 in aggregatorsql):
```sql
CREATE OR REPLACE FUNCTION calc_dxy_range_derived(...)
RETURNS jsonb AS $$
BEGIN
  -- Reads FX pairs from data_bars
  -- Calculates DXY using formula
  -- ⚠️ Inserts into derived_data_bars with source='dxy'
  
  INSERT INTO derived_data_bars (
    canonical_symbol, timeframe, ts_utc,
    open, high, low, close,
    source, ...
  )
  SELECT 'DXY', '1m', ts_utc,
    dxy_close, dxy_close, dxy_close, dxy_close,
    'dxy', ...  -- ⚠️ Still writes to derived_data_bars
  FROM calculated_dxy_values
  ...
END $$;
```

**Status**: 
- ❌ This function still writes to `derived_data_bars`
- ✅ We created new function `calc_dxy_range_1m()` that writes to `data_bars`
- ⚠️ Old function still exists but should not be called
- 📋 Tick-factory needs to call new function (Phase 6)

### 3.5 `calc_dxy_range_1m()` - NEW FUNCTION

**Our Implementation** (created in Phase 3):
```sql
CREATE OR REPLACE FUNCTION calc_dxy_range_1m(
  p_from_utc timestamptz,
  p_to_utc timestamptz,
  p_derivation_version int DEFAULT 1
)
RETURNS jsonb AS $$
BEGIN
  -- Same calculation logic as calc_dxy_range_derived
  -- BUT: Inserts into data_bars instead
  
  INSERT INTO data_bars (
    canonical_symbol, timeframe, ts_utc,
    open, high, low, close,
    source, ...
  )
  SELECT 'DXY', '1m', ts_utc,
    dxy_price, dxy_price, dxy_price, dxy_price,
    'synthetic', ...  -- ✅ Writes to data_bars
  FROM calculated_dxy_values
  ON CONFLICT (canonical_symbol, timeframe, ts_utc)
  DO UPDATE SET ...;
  
  RETURN jsonb_build_object(
    'success', true,
    'inserted', v_inserted,
    'updated', v_updated,
    'skipped', v_skipped
  );
END $$;
```

**Status**:
- ✅ Function created and tested
- ✅ Used to regenerate 11,839 DXY bars
- ⚠️ Not yet integrated into tick-factory (Phase 6)

---

## 4. Worker Code (TypeScript)

### 4.1 `aggworker.ts` - Cloudflare Worker

**Location**: `apps/typescript/aggregator/src/aggworker.ts`

**Flow**:
```typescript
1. Cron trigger → runAggregation()

2. Get due tasks:
   const { data: tasks } = await supabase.rpc('agg_get_due_tasks', {
     p_env_name: envName,
     p_limit: maxTasks
   });
   
   // Returns: [{canonical_symbol, timeframe, source_timeframe, ...}]

3. For each task:
   a. Start task:
      await supabase.rpc('agg_start', {p_symbol, p_tf});
   
   b. Bootstrap cursor if needed:
      await supabase.rpc('agg_bootstrap_cursor', {p_symbol, p_to_tf});
   
   c. Run aggregation:
      await supabase.rpc('catchup_aggregation_range', {
        p_symbol,
        p_to_tf: toTf,
        p_start_cursor_utc: cursorIso,
        p_max_windows: maxWindows,
        p_derivation_version: derivationVersion
      });
      
   d. Finish task:
      await supabase.rpc('agg_finish', {
        p_symbol,
        p_tf,
        p_success: true,
        p_new_cursor_utc: newCursor,
        p_stats: {...}
      });

4. Prune old logs:
   await supabase.rpc('ops_runlog_prune', {...});
```

**No Changes Needed**:
- Worker only calls RPC functions
- All logic is in SQL functions
- Updating SQL functions is sufficient

### 4.2 Error Handling

```typescript
function isTransientError(e: any): boolean {
  const msg = String(e?.message ?? e ?? '');
  return (
    msg.includes('timeout') ||
    msg.includes('ECONNRESET') ||
    msg.includes('429') ||
    ...
  );
}

// On error:
await supabase.rpc('agg_finish', {
  p_success: false,
  p_fail_kind: transient ? 'transient' : 'hard',
  p_error: String(e?.message ?? e)
});
```

**Auto-Disable Logic**:
- Hard failures increment `hard_fail_streak`
- After 3 consecutive hard failures → status='disabled'
- Transient failures don't increment streak

---

## 5. Migration Changes Required

### 5.1 `aggregate_1m_to_5m_window()` - REMOVE UNION ALL

**Current**:
```sql
WITH src AS (
  SELECT ... FROM data_bars WHERE timeframe='1m' ...
  UNION ALL
  SELECT ... FROM derived_data_bars WHERE timeframe='1m' ...
)
```

**Updated**:
```sql
WITH src AS (
  -- Only query data_bars (DXY now included there)
  SELECT ... FROM data_bars WHERE timeframe='1m' ...
)
```

**Impact**:
- ✅ Simpler query (single table scan)
- ✅ Better performance (no UNION overhead)
- ✅ Clearer semantics (1m = data_bars)
- ⚠️ Must apply BEFORE production use

### 5.2 `catchup_aggregation_range()` - CONDITIONAL UNION

**Current**:
```sql
-- Always uses UNION ALL for max timestamp check
SELECT MAX(ts_utc) INTO v_max_source_ts
FROM (
  SELECT ts_utc FROM data_bars WHERE timeframe=v_src_tf
  UNION ALL
  SELECT ts_utc FROM derived_data_bars WHERE timeframe=v_src_tf ...
) x;
```

**Updated**:
```sql
-- Conditional based on source timeframe
IF v_src_tf = '1m' THEN
  -- For 1m source: only query data_bars
  SELECT MAX(ts_utc) INTO v_max_source_ts
  FROM data_bars
  WHERE canonical_symbol=p_symbol AND timeframe=v_src_tf;
ELSE
  -- For 5m+ source: use UNION ALL (data still in derived_data_bars)
  SELECT MAX(ts_utc) INTO v_max_source_ts
  FROM (
    SELECT ts_utc FROM data_bars WHERE timeframe=v_src_tf
    UNION ALL
    SELECT ts_utc FROM derived_data_bars WHERE timeframe=v_src_tf ...
  ) x;
END IF;
```

**Rationale**:
- 1m data → `data_bars` only
- 5m+ data → `derived_data_bars` (with potential `data_bars` fallback)

### 5.3 `aggregate_5m_to_1h_window()` - NO CHANGE

Already correct - only queries `derived_data_bars` for 5m source.

---

## 6. Testing Plan (Phase 6)

### 6.1 Unit Tests

**Test 1: DXY 5m Aggregation**
```sql
-- Manually trigger 5m aggregation for DXY
SELECT aggregate_1m_to_5m_window(
  'DXY',
  '2026-01-13 10:00:00+00'::timestamptz,
  '2026-01-13 10:05:00+00'::timestamptz,
  1
);

-- Expected result:
{
  "success": true,
  "stored": true,
  "source_count": 5,
  "quality_score": 2
}

-- Verify bar was created:
SELECT * FROM derived_data_bars
WHERE canonical_symbol='DXY' 
  AND timeframe='5m'
  AND ts_utc='2026-01-13 10:00:00+00';
```

**Test 2: Regular Asset (EURUSD) Still Works**
```sql
SELECT aggregate_1m_to_5m_window(
  'EURUSD',
  '2026-01-13 10:00:00+00'::timestamptz,
  '2026-01-13 10:05:00+00'::timestamptz,
  1
);
```

**Test 3: Catchup Range**
```sql
SELECT catchup_aggregation_range(
  'DXY',
  '5m',
  '2026-01-13 09:00:00+00'::timestamptz,
  12,  -- Process 1 hour of 5m windows
  NOW(),
  1,
  false
);
```

### 6.2 Integration Test

**Full Aggregator Run**:
1. Deploy updated functions
2. Reset DXY cursor to safe position:
   ```sql
   UPDATE data_agg_state
   SET last_agg_bar_ts_utc = '2026-01-13 09:00:00+00',
       status = 'idle',
       next_run_at = NOW()
   WHERE canonical_symbol='DXY' AND timeframe='5m';
   ```
3. Trigger aggregator manually or wait for cron
4. Verify:
   - Bars created in `derived_data_bars`
   - Cursor advanced properly
   - No errors in logs

### 6.3 Data Validation

**Consistency Checks**:
```sql
-- Check 5m bars have correct source counts
SELECT 
  ts_utc,
  source_candles,
  expected_candles,
  quality_score
FROM derived_data_bars
WHERE canonical_symbol='DXY'
  AND timeframe='5m'
  AND ts_utc >= '2026-01-13 00:00:00'
ORDER BY ts_utc DESC
LIMIT 20;

-- Verify OHLC integrity (high >= low, etc.)
SELECT 
  ts_utc,
  high >= low AS high_gte_low,
  open BETWEEN low AND high AS open_valid,
  close BETWEEN low AND high AS close_valid
FROM derived_data_bars
WHERE canonical_symbol='DXY'
  AND timeframe='5m'
  AND (high < low OR open NOT BETWEEN low AND high);
  -- Should return no rows
```

---

## 7. Rollback Plan

### If Issues Found After Deployment

**Step 1: Revert Functions**
```sql
-- Restore old aggregate_1m_to_5m_window with UNION ALL
-- (Keep backup of current version)
```

**Step 2: Disable DXY Tasks**
```sql
UPDATE data_agg_state
SET status='disabled'
WHERE canonical_symbol='DXY';
```

**Step 3: Investigate**
- Check error logs
- Review data consistency
- Test individual function calls

**Step 4: Re-enable Once Fixed**
```sql
UPDATE data_agg_state
SET status='idle',
    hard_fail_streak=0,
    last_error=NULL
WHERE canonical_symbol='DXY';
```

---

## 8. Post-Migration Cleanup (Phase 9)

### After 24-48 Hours of Successful Operation

**Step 1: Verify New System**
```sql
-- Check that 5m/1h bars are being created properly
SELECT 
  canonical_symbol,
  timeframe,
  COUNT(*) as bar_count,
  MAX(ts_utc) as latest_bar
FROM derived_data_bars
WHERE canonical_symbol='DXY'
  AND timeframe IN ('5m', '1h')
  AND deleted_at IS NULL
  AND ts_utc >= NOW() - INTERVAL '48 hours'
GROUP BY canonical_symbol, timeframe;
```

**Step 2: Soft-Delete Legacy DXY 1m**
```sql
-- Soft delete old DXY 1m bars in derived_data_bars
UPDATE derived_data_bars
SET deleted_at = NOW(),
    raw = raw || jsonb_build_object(
      'migration_cleanup', 
      jsonb_build_object(
        'reason', 'dxy_migrated_to_data_bars',
        'migration_date', '2026-01-13'
      )
    )
WHERE canonical_symbol='DXY'
  AND timeframe='1m'
  AND source='dxy'
  AND deleted_at IS NULL;

-- Verify count
SELECT COUNT(*) FROM derived_data_bars
WHERE canonical_symbol='DXY' 
  AND timeframe='1m' 
  AND deleted_at IS NOT NULL;
-- Should be ~4,666 (old legacy data)
```

**Step 3: Drop Old Function (Optional)**
```sql
-- After several weeks of stable operation
DROP FUNCTION IF EXISTS calc_dxy_range_derived(timestamptz, timestamptz, text, int);
```

---

## 9. Key Metrics to Monitor

### Before Deployment
- DXY 1m count in `data_bars`: **11,839 bars**
- DXY 1m count in `derived_data_bars`: **4,666 bars** (legacy)
- DXY 5m count: Check baseline
- DXY 1h count: Check baseline

### After Deployment
- **Aggregation Success Rate**: Should be >95%
- **Quality Scores**: Most bars should be quality_score=2 (excellent)
- **Cursor Advancement**: Should advance steadily without stalling
- **Error Logs**: Should not have "insufficient_source_bars" for DXY
- **Hard Fail Streak**: Should remain at 0

### Query Performance
```sql
-- Measure before/after
EXPLAIN ANALYZE
SELECT * FROM data_bars
WHERE canonical_symbol='DXY' AND timeframe='1m'
  AND ts_utc >= NOW() - INTERVAL '1 hour';

-- vs old UNION ALL query
EXPLAIN ANALYZE
SELECT * FROM (
  SELECT * FROM data_bars WHERE canonical_symbol='DXY' AND timeframe='1m'
  UNION ALL
  SELECT * FROM derived_data_bars WHERE canonical_symbol='DXY' AND timeframe='1m'
) x
WHERE ts_utc >= NOW() - INTERVAL '1 hour';
```

---

## 10. Questions & Answers

### Q: Why not migrate 5m/1h data too?
**A**: 5m/1h are aggregated data - they logically belong in `derived_data_bars`. Only 1m DXY is synthetic from formula, making it more like raw market data.

### Q: What if we need to recalculate historical DXY?
**A**: Use `calc_dxy_range_1m()` function with any date range. It will upsert (update or insert) bars.

### Q: How do we know UNION ALL removal is safe?
**A**: After Phase 4, ALL 1m data (including DXY) is in `data_bars`. The UNION ALL would just duplicate queries to an empty result set.

### Q: What about other synthetic instruments in the future?
**A**: Follow same pattern - calculate and store in `data_bars` with source='synthetic'. Keep aggregated timeframes in `derived_data_bars`.

### Q: Can we test in production safely?
**A**: Yes, with these safeguards:
1. Deploy during low-traffic window
2. Monitor first few runs closely
3. Have rollback SQL ready
4. Test with single asset first (DXY only)
5. Keep old data as backup

---

## 11. Approval Checklist

Before proceeding to Phase 5 deployment:

- [ ] All reviewers understand the architecture changes
- [ ] SQL migration file reviewed and approved
- [ ] Test plan is comprehensive
- [ ] Rollback procedure is clear
- [ ] Monitoring metrics identified
- [ ] Backup of current functions saved
- [ ] Off-hours deployment window scheduled
- [ ] Team available for immediate issue response

---

## 12. Files Changed

### Created
- `db/migrations/010_dxy_migration_update_aggregation.sql` (NEW)
- `scripts/dxy_migration_phase5.py` (NEW)
- `scripts/dxy_migration_phase3.py` (Phase 3)
- `scripts/dxy_migration_phase4_regenerate.py` (Phase 4)
- `scripts/calc_dxy_range_1m()` function (Phase 3)

### Modified (Planned)
- `aggregate_1m_to_5m_window()` - Remove UNION ALL
- `catchup_aggregation_range()` - Conditional source query

### No Changes
- `aggregate_5m_to_1h_window()` - Already correct
- `aggworker.ts` - No changes needed
- `data_agg_state` table - No schema changes
- `data_bars` / `derived_data_bars` - Schema unchanged

---

**End of Review Document**

Next Step: Proceed to Phase 5 deployment after approval.
