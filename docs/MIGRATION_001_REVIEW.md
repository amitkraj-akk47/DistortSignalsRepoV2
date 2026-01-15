# Independent Review: Migration 001 (RPC Validation Suite v2.1)

**Reviewer**: Independent Technical Review  
**Date**: 2026-01-15  
**Migration File**: `db/migrations/001_create_quality_validation_rpcs.sql`  
**Version**: 2.1  
**Line Count**: 1,222 lines  
**Status**: ⚠️ CONDITIONAL APPROVAL WITH CRITICAL ISSUES

---

## Executive Summary

**Overall Assessment**: The migration contains well-structured validation logic but has **5 CRITICAL BUGS** and **8 HIGH-PRIORITY ISSUES** that must be fixed before production deployment.

**Recommendation**: **DO NOT DEPLOY** until critical issues are resolved.

---

## Critical Issues (MUST FIX)

### 🔴 CRITICAL #1: RPC 1 - p_env_name Parameter Unused
**Location**: Lines 30-115  
**Severity**: HIGH  
**Impact**: Function ignores environment parameter, will scan ALL environments

**Problem**:
```sql
-- Parameter p_env_name is validated but NEVER USED in queries
SELECT canonical_symbol, '1m' as timeframe, 'data_bars' as table_name, ts_utc FROM data_bars
UNION ALL
SELECT canonical_symbol, timeframe, 'derived_data_bars' as table_name, ts_utc FROM derived_data_bars
-- NO WHERE env_name = p_env_name filter!
```

**Impact**: 
- Staging and production data mixed together
- Performance degradation (full table scans)
- Incorrect validation results

**Fix Required**:
```sql
SELECT canonical_symbol, '1m' as timeframe, 'data_bars' as table_name, ts_utc 
FROM data_bars 
WHERE env_name = p_env_name  -- ADD THIS

UNION ALL

SELECT canonical_symbol, timeframe, 'derived_data_bars' as table_name, ts_utc 
FROM derived_data_bars
WHERE env_name = p_env_name  -- ADD THIS
```

**Affects**: RPC 1, 2, 3, 6, 7, 8, 9 (all RPCs that accept p_env_name but don't use it)

---

### 🔴 CRITICAL #2: RPC 2 - Broken Ladder Logic
**Location**: Lines 168-185  
**Severity**: CRITICAL  
**Impact**: False negatives - will NOT detect missing derived data

**Problem**:
```sql
ladder_check AS (
  SELECT 
    s.canonical_symbol,
    CASE
      WHEN COUNT(*) FILTER (WHERE d.timeframe = '5m' AND d.canonical_symbol IS NOT NULL) = 0 THEN 1
      ELSE 0
    END as missing_5m_derived,
    ...
  FROM active_symbols s
  LEFT JOIN derived_data_bars d ON s.canonical_symbol = d.canonical_symbol
  GROUP BY s.canonical_symbol
)
```

**Why It's Broken**:
- LEFT JOIN returns ALL rows from `active_symbols`
- `COUNT(*) FILTER (WHERE d.timeframe = '5m')` counts rows, not distinct symbols
- If symbol has ANY rows in derived_data_bars (even 1h only), COUNT > 0
- Missing 5m will still return 0 (false negative)

**Correct Logic**:
```sql
ladder_check AS (
  SELECT 
    s.canonical_symbol,
    CASE
      WHEN NOT EXISTS (
        SELECT 1 FROM derived_data_bars d2 
        WHERE d2.canonical_symbol = s.canonical_symbol 
        AND d2.timeframe = '5m'
      ) THEN 1
      ELSE 0
    END as missing_5m_derived,
    CASE
      WHEN NOT EXISTS (
        SELECT 1 FROM derived_data_bars d3 
        WHERE d3.canonical_symbol = s.canonical_symbol 
        AND d3.timeframe = '1h'
      ) THEN 1
      ELSE 0
    END as missing_1h_derived
  FROM active_symbols s
)
```

---

### 🔴 CRITICAL #3: RPC 5 - OHLC Reconciliation Window Off-By-One
**Location**: Lines 487-495  
**Severity**: HIGH  
**Impact**: Comparing wrong source bars to derived bars

**Problem**:
```sql
LEFT JOIN data_bars b ON 
  d.canonical_symbol = b.canonical_symbol
  AND d.timeframe = '5m'
  AND b.timeframe = '1m'
  AND b.ts_utc >= d.ts_utc - INTERVAL '5 minutes'  -- WRONG!
  AND b.ts_utc < d.ts_utc                          -- WRONG!
```

**Why It's Wrong**:
- A 5m bar at `10:05:00` represents data from `10:00:00` to `10:04:59`
- Your query looks for source bars from `10:00:00` to `10:04:59` ✓
- But derived bar timestamp `d.ts_utc` is the END of the period (10:05:00)
- You're excluding the bar at `10:05:00` itself!

**Correct Window**:
```sql
AND b.ts_utc >= d.ts_utc - INTERVAL '5 minutes'
AND b.ts_utc <= d.ts_utc  -- Use <= not <
```

**Same Issue in 1h Aggregation** (Lines 514-522)

---

### 🔴 CRITICAL #4: RPC 9 - Random Sampling Before Windowing
**Location**: Lines 1076-1089  
**Severity**: MEDIUM  
**Impact**: LAG comparison can span different symbols/timeframes (still broken!)

**Problem**:
```sql
WITH sampled_rows AS (
  SELECT canonical_symbol, timeframe, ts_utc, open, high, low, close
  FROM (
    SELECT ... FROM data_bars WHERE ts_utc > NOW() - (p_window_weeks || ' weeks')::INTERVAL
    UNION ALL
    SELECT ... FROM derived_data_bars WHERE ts_utc > NOW() - (p_window_weeks || ' weeks')::INTERVAL
  ) combined
  ORDER BY RANDOM()  -- Random BEFORE LAG computation!
  LIMIT p_sample_size
)
```

**Why Still Broken**:
- You sample 10,000 random rows
- Then apply LAG partitioned by (symbol, timeframe)
- But each partition may have only 1-2 rows from random sample
- LAG will mostly return NULL (no previous row in partition)
- Price jump detection becomes useless

**Correct Approach**:
```sql
-- Sample SYMBOLS first, then compute LAG over full time series for those symbols
WITH sampled_symbols AS (
  SELECT DISTINCT canonical_symbol FROM (
    SELECT canonical_symbol FROM data_bars 
    WHERE ts_utc > NOW() - (p_window_weeks || ' weeks')::INTERVAL
    ORDER BY RANDOM() LIMIT 100
  )
),
full_time_series AS (
  SELECT s.canonical_symbol, d.timeframe, d.ts_utc, d.open, d.high, d.low, d.close
  FROM sampled_symbols s
  JOIN data_bars d ON s.canonical_symbol = d.canonical_symbol
  WHERE d.ts_utc > NOW() - (p_window_weeks || ' weeks')::INTERVAL
),
with_lag AS (
  SELECT *,
    LAG(close) OVER (PARTITION BY canonical_symbol, timeframe ORDER BY ts_utc) as prev_close
  FROM full_time_series
)
SELECT ... FROM with_lag
```

---

### 🔴 CRITICAL #5: All RPCs - Missing env_name in Table Schemas
**Location**: All functions  
**Severity**: CRITICAL (BLOCKING)  
**Impact**: Cannot deploy - queries will fail if tables don't have env_name column

**Problem**: 
Every query assumes `data_bars` and `derived_data_bars` have an `env_name` column, but:
- No migration creates this column
- No schema definition provided
- If column doesn't exist, ALL RPCs will fail with `column "env_name" does not exist`

**Required Pre-Migration**:
```sql
-- Run BEFORE 001_create_quality_validation_rpcs.sql
ALTER TABLE data_bars ADD COLUMN IF NOT EXISTS env_name TEXT NOT NULL DEFAULT 'production';
ALTER TABLE derived_data_bars ADD COLUMN IF NOT EXISTS env_name TEXT NOT NULL DEFAULT 'production';
CREATE INDEX IF NOT EXISTS idx_data_bars_env_name ON data_bars(env_name);
CREATE INDEX IF NOT EXISTS idx_derived_data_bars_env_name ON derived_data_bars(env_name);
```

**OR**: Remove all p_env_name parameters and env_name filters (if multi-tenancy not needed)

---

## High-Priority Issues (SHOULD FIX)

### 🟠 HIGH #1: RPC 1 - p_window_minutes Validated But Never Used
**Location**: Lines 51-56  
**Severity**: MEDIUM  

The function validates `p_window_minutes` parameter but the comment explicitly says "Do NOT filter by window". This is confusing:

```sql
IF p_window_minutes IS NULL OR p_window_minutes < 1 THEN
  p_window_minutes := 20;
END IF;
p_window_minutes := LEAST(ABS(p_window_minutes), 1440);

-- But then:
-- NOTE: Do NOT filter by window; we need to catch assets that have stopped transmitting entirely.
```

**Decision Required**: 
- If parameter unused, remove it from signature
- If needed for future use, document why it exists

---

### 🟠 HIGH #2: RPC 2 - Issue Details Logic Inverted
**Location**: Lines 189-213  
**Severity**: MEDIUM  

```sql
SELECT jsonb_build_object(
  'canonical_symbol', canonical_symbol,
  'missing_5m_derived', CASE WHEN missing_5m > 0 THEN 'yes' ELSE 'no' END,
  ...
) as item
FROM (
  SELECT s.canonical_symbol,
    COUNT(*) FILTER (WHERE d.timeframe = '5m') as missing_5m,  -- WRONG!
    COUNT(*) FILTER (WHERE d.timeframe = '1h') as missing_1h   -- WRONG!
  ...
  HAVING COUNT(*) FILTER (WHERE d.timeframe = '5m') = 0 OR ...
```

**Problem**: 
- Variable named `missing_5m` but it counts EXISTING 5m rows
- Logic is backwards: `missing_5m > 0` means "has 5m data" not "missing 5m data"

**Fix**: Rename to `has_5m_derived` or invert the CASE logic

---

### 🟠 HIGH #3: RPC 5 - Source Open vs First Open Confusion
**Location**: Lines 500-504  
**Severity**: MEDIUM  

```sql
MIN(b.open) as source_first_open,  -- MIN(open)?!
MAX(b.high) as source_max_high,
MIN(b.low) as source_min_low,
MAX(b.close) as source_last_close   -- MAX(close)?!
```

**Problem**:
- `MIN(b.open)` gets the LOWEST open price in the window (wrong!)
- Should get open price of FIRST bar by timestamp
- `MAX(b.close)` gets the HIGHEST close price (wrong!)
- Should get close price of LAST bar by timestamp

**Correct Query**:
```sql
(SELECT b.open FROM data_bars b2 
 WHERE b2.canonical_symbol = d.canonical_symbol AND b2.timeframe = '1m'
   AND b2.ts_utc >= d.ts_utc - INTERVAL '5 minutes' AND b2.ts_utc <= d.ts_utc
 ORDER BY b2.ts_utc ASC LIMIT 1) as source_first_open,
 
MAX(b.high) as source_max_high,  -- This is correct
MIN(b.low) as source_min_low,    -- This is correct

(SELECT b.close FROM data_bars b3
 WHERE b3.canonical_symbol = d.canonical_symbol AND b3.timeframe = '1m'
   AND b3.ts_utc >= d.ts_utc - INTERVAL '5 minutes' AND b3.ts_utc <= d.ts_utc
 ORDER BY b3.ts_utc DESC LIMIT 1) as source_last_close
```

**Impact**: False positives for open/close reconciliation

---

### 🟠 HIGH #4: RPC 7 - Business Hours Schedule Assumption Undocumented
**Location**: Lines 896-901  
**Severity**: LOW-MEDIUM  

```sql
AND EXTRACT(ISODOW FROM ts_utc) BETWEEN 1 AND 5  -- Mon-Fri only
AND (EXTRACT(HOUR FROM ts_utc) >= 22 OR EXTRACT(HOUR FROM ts_utc) < 21)  -- 22:00-20:59
```

**Problem**:
- Assumes Forex schedule (24/5 with 1hr close on weekends)
- Crypto markets are 24/7
- Stock markets have different hours (9:30-16:00 ET)
- DXY components have varied schedules

**Missing**: 
- Document which assets use which schedule
- Consider per-asset schedule configuration
- Or make schedule configurable via parameters

---

### 🟠 HIGH #5: RPC 4 - Tolerance Mode Pass/Fail Logic Unclear
**Location**: Lines 376-392  
**Severity**: LOW  

```sql
WHEN p_tolerance_mode = 'degraded' THEN
  CASE
    WHEN v_coverage_pct >= 83.33 THEN 'pass'  -- 5/6 components = pass
    WHEN v_coverage_pct >= 66.67 THEN 'warning'
    ELSE 'critical'
  END
```

**Problem**: 
- `83.33%` threshold assumes 5/6 components present
- But v_coverage_pct is percentage of BARS with 6 components, not component availability
- If 50% of bars have 6/6 components and 50% have 0/6, coverage = 50% (critical)
- But that's very different from "all bars have 5/6 components" (also ~83%)

**Clarification Needed**: What does tolerance mode actually mean?

---

### 🟠 HIGH #6: All RPCs - No Execution Time Tracking
**Location**: All functions  
**Severity**: LOW  

Every RPC returns:
```sql
'execution_time_ms', 0,  -- Always 0!
```

**Missing**: 
```sql
DECLARE
  v_start_time TIMESTAMPTZ;
BEGIN
  v_start_time := clock_timestamp();
  
  -- ... do work ...
  
  v_result := jsonb_build_object(
    'execution_time_ms', EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000,
    ...
  );
```

---

### 🟠 HIGH #7: RPC 3 - Inefficient Duplicate Detection
**Location**: Lines 240-253  
**Severity**: MEDIUM (Performance)  

```sql
SELECT canonical_symbol, timeframe, ts_utc
FROM data_bars
WHERE ts_utc > NOW() - (p_window_days || ' days')::INTERVAL
UNION ALL  -- Merges both tables
SELECT canonical_symbol, timeframe, ts_utc
FROM derived_data_bars
WHERE ts_utc > NOW() - (p_window_days || ' days')::INTERVAL
) combined
GROUP BY canonical_symbol, timeframe, ts_utc
HAVING COUNT(*) > 1  -- Finds duplicates ACROSS tables (wrong!)
```

**Problem**:
- UNION ALL combines rows from both tables
- `HAVING COUNT(*) > 1` finds (symbol, timeframe, ts_utc) tuples that exist in BOTH tables
- But duplicates should be WITHIN each table, not across tables
- DXY 5m should exist in derived_data_bars but not data_bars (not a duplicate!)

**Fix**: Check each table separately

---

### 🟠 HIGH #8: RPC 6 - Zero Range Bars Not Considered Error
**Location**: Lines 690-694  
**Severity**: LOW  

```sql
COUNT(*) FILTER (WHERE high = low AND open = close AND close = high) as zero_range,
-- But zero_range is NOT included in v_issue_count!

v_issue_count := COALESCE(v_high_less_low, 0) + COALESCE(v_open_out_of_range, 0) 
               + COALESCE(v_close_out_of_range, 0) + COALESCE(v_excessive_spread, 0);
-- Zero range missing here!
```

**Decision Needed**: Are zero-range bars valid (e.g., no trades in 1m bar) or errors?

---

## Medium-Priority Issues (NICE TO FIX)

### 🟡 MEDIUM #1: Inconsistent NULL Handling in COALESCE
Some functions use `COALESCE(var, 0)` defensively, others assume NOT NULL. Be consistent.

### 🟡 MEDIUM #2: No Query Timeout Protection
Functions marked `VOLATILE` but no `statement_timeout` guard. Consider:
```sql
SET LOCAL statement_timeout = '30s';
```

### 🟡 MEDIUM #3: LIMIT 100 for Issue Details May Hide Scope
All issue_details arrays capped at 100 items, but issue_count may be 10,000. User won't see full scope.

### 🟡 MEDIUM #4: No Index Recommendations
Migration doesn't create indexes for:
- `(canonical_symbol, timeframe, ts_utc)` - needed for all RPCs
- `(env_name, canonical_symbol)` - if env_name added
- `(ts_utc DESC)` - for staleness queries

---

## Security Assessment

### ✅ PASS: SQL Injection Protection
- All parameters validated
- No dynamic SQL construction
- Enum validation for p_tolerance_mode

### ✅ PASS: Resource Exhaustion Prevention
- Window parameters bounded (max 1440m, 365d, 52w)
- Sample sizes capped (1000-50000)
- LIMIT clauses on all issue_details

### ⚠️ PARTIAL: Role/Permission Management
- GRANTs commented out (good - handle separately)
- But no documentation on required permissions
- Missing: SELECT grants on data_bars/derived_data_bars

---

## Performance Assessment

### ⚠️ CONCERNS:

1. **RPC 1**: Full table scan on data_bars + derived_data_bars (no env_name filter, no indexes)
2. **RPC 2**: LEFT JOIN with no index on (canonical_symbol, timeframe)
3. **RPC 5**: Nested loop for each derived bar joining to source bars
4. **RPC 7**: Business hours filter (`EXTRACT(HOUR)`) not sargable (can't use indexes)
5. **RPC 9**: RANDOM() on 10k+ rows, then LAG over sparse partitions

**Expected Runtime** (without fixes):
- RPC 1: 30-60 seconds (full table scan)
- RPC 2: 10-20 seconds
- RPC 5: 60-120 seconds (nested loop for 50 samples)
- RPC 7: 40-80 seconds
- RPC 9: 20-40 seconds

**WAY OVER** stated SLA (<2-8 seconds)

---

## Correctness Assessment

| RPC | Logic Correct? | Edge Cases Handled? | Status |
|-----|----------------|---------------------|---------|
| 1 - Staleness | ❌ No (missing env filter) | ⚠️ Partial | FAIL |
| 2 - Architecture Gates | ❌ No (broken ladder logic) | ❌ No | FAIL |
| 3 - Duplicates | ❌ No (checks across tables) | ⚠️ Partial | FAIL |
| 4 - DXY Components | ✅ Yes | ✅ Yes | PASS |
| 5 - Reconciliation | ❌ No (wrong OHLC logic) | ⚠️ Partial | FAIL |
| 6 - OHLC Integrity | ✅ Yes | ✅ Yes | PASS |
| 7 - Gap Density | ⚠️ Partial (schedule assumption) | ❌ No | CONDITIONAL |
| 8 - Coverage Ratios | ⚠️ Partial (schedule assumption) | ❌ No | CONDITIONAL |
| 9 - Historical | ❌ No (random before LAG) | ❌ No | FAIL |

**Verdict: 2/9 PASS, 5/9 FAIL, 2/9 CONDITIONAL**

---

## Deployment Readiness Checklist

- [ ] ❌ **BLOCKER**: Missing env_name column in data_bars/derived_data_bars
- [ ] ❌ **BLOCKER**: RPC 1 env_name filter not implemented
- [ ] ❌ **BLOCKER**: RPC 2 ladder logic broken
- [ ] ❌ **BLOCKER**: RPC 3 duplicate logic checks across tables
- [ ] ❌ **BLOCKER**: RPC 5 OHLC reconciliation wrong (MIN/MAX instead of FIRST/LAST)
- [ ] ❌ **BLOCKER**: RPC 5 time window off-by-one error
- [ ] ❌ **CRITICAL**: RPC 9 random sampling breaks LAG
- [ ] ⚠️ **HIGH**: No indexes created for query optimization
- [ ] ⚠️ **HIGH**: No execution time tracking implemented
- [ ] ⚠️ **MEDIUM**: Business hours schedule assumptions undocumented
- [ ] ✅ **PASS**: SQL injection protection adequate
- [ ] ✅ **PASS**: Resource exhaustion guards in place
- [ ] ✅ **PASS**: Error handling implemented

---

## Recommendations

### Immediate Actions (Before Any Deployment)

1. **Fix Critical #5 First**: Add env_name columns to tables OR remove env_name parameters
2. **Fix Critical #1**: Add `WHERE env_name = p_env_name` to all queries
3. **Fix Critical #2**: Rewrite RPC 2 ladder logic using EXISTS
4. **Fix Critical #3**: Fix RPC 5 time window (use `<=` not `<`)
5. **Fix High #3**: Fix RPC 5 open/close logic (FIRST/LAST not MIN/MAX)
6. **Fix Critical #4**: Fix RPC 9 sampling strategy
7. **Fix High #7**: Fix RPC 3 to check duplicates within each table

### Before Production Deployment

8. Create indexes:
   ```sql
   CREATE INDEX idx_data_bars_lookup ON data_bars(env_name, canonical_symbol, timeframe, ts_utc DESC);
   CREATE INDEX idx_derived_lookup ON derived_data_bars(env_name, canonical_symbol, timeframe, ts_utc DESC);
   ```

9. Add execution time tracking to all RPCs

10. Load test each RPC with production-scale data:
    - Target: <5 seconds for 90th percentile
    - Target: <10 seconds for 99th percentile

11. Document business hours assumptions for RPC 7/8

### Nice-to-Haves

12. Add query timeout guards (`SET LOCAL statement_timeout`)
13. Add RPC versioning (return `rpc_version: '2.1'` in results)
14. Consider pagination for issue_details (currently capped at 100)

---

## Risk Assessment

**Deployment Risk: 🔴 EXTREME**

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| All RPCs fail (no env_name column) | HIGH | CRITICAL | Add column before migration |
| False negatives (broken logic) | HIGH | HIGH | Fix logic bugs before deploy |
| Timeout/performance issues | MEDIUM | HIGH | Add indexes, test with real data |
| Incorrect validation results | HIGH | HIGH | Fix OHLC/ladder/staleness logic |
| Production outage (long queries) | MEDIUM | CRITICAL | Load test first, add timeouts |

---

## Final Verdict

**STATUS: ❌ NOT READY FOR DEPLOYMENT**

**Confidence Level**: HIGH (systematic review completed)

**Must Fix Before Staging**: 
- All 5 CRITICAL issues
- HIGH issues #2, #3, #7

**Must Fix Before Production**:
- All HIGH issues
- Index creation
- Load testing validation

**Estimated Fix Time**: 
- Critical fixes: 4-6 hours
- High-priority fixes: 3-4 hours
- Testing: 2-3 hours
- **Total: 9-13 hours**

---

## Next Steps

1. **Do NOT deploy this migration**
2. **Fix critical issues** listed above
3. **Create test dataset** with known issues
4. **Validate each RPC** returns expected results
5. **Load test** with production-scale data
6. **Re-review** after fixes applied
7. **Deploy to staging** only after re-review passes
8. **Monitor closely** for 48 hours
9. **Deploy to production** only after staging validation

---

**End of Independent Review**
