# Aggregator Pre-Deployment Verification

## ✅ Item #3: SQL UNION ALL for DXY - CONFIRMED

**Status: READY** ✅

The `aggregate_1m_to_5m_window` function already uses `UNION ALL` to source from both tables:

```sql
with src as (
  select ts_utc,open,high,low,close,vol,vwap,trade_count from data_bars
    where canonical_symbol=p_symbol and timeframe='1m' and ts_utc>=p_from_utc and ts_utc<p_to_utc
  union all
  select ts_utc,open,high,low,close,vol,vwap,trade_count from derived_data_bars
    where canonical_symbol=p_symbol and timeframe='1m' and deleted_at is null and ts_utc>=p_from_utc and ts_utc<p_to_utc
),
```

This means DXY 1m bars (stored in `derived_data_bars`) will be correctly included when aggregating to 5m.

---

## ❌ Item #1: DXY Derivation in Tick-Factory - MISSING

**Status: NEEDS PATCH** ❌

The tick-factory worker does NOT currently call `calc_dxy_range_derived` after FX ingestion.

**Required Action:** Add DXY derivation logic after successful FX ingestion.

### Where to Add:
After Step 7 (ingest_asset_finish success), check if the asset is one of the 6 FX pairs, and if so, trigger DXY calculation for that time window.

### Implementation Plan:
1. Track FX pairs ingested in current run with their time windows
2. After each successful FX pair ingestion, check if we have all 6 pairs for the same window
3. If complete set available, call `calc_dxy_range_derived(from, to, '1m', 1)`
4. Log DXY derivation success/failure

**See: `TICK_FACTORY_DXY_PATCH.md` for implementation details**

---

## ⚠️ Item #2: data_agg_state Tasks - NEEDS VERIFICATION

**Status: MANUAL CHECK REQUIRED** ⚠️

Run this SQL query to verify your task configuration:

```sql
SELECT canonical_symbol, timeframe, source_timeframe, 
       run_interval_minutes, aggregation_delay_seconds, 
       status, is_mandatory
FROM data_agg_state
ORDER BY canonical_symbol, timeframe;
```

### Expected Configuration:

#### Regular Symbols (XAUUSD, EURUSD, USDJPY, GBPUSD, USDCAD, USDSEK, USDCHF, etc.)
- `timeframe='5m'`, `source_timeframe='1m'`, `run_interval_minutes=5`
- `timeframe='1h'`, `source_timeframe='5m'`, `run_interval_minutes=60`

#### DXY (Special Case)
- ✅ `timeframe='5m'`, `source_timeframe='1m'`, `run_interval_minutes=5`
- ✅ `timeframe='1h'`, `source_timeframe='5m'`, `run_interval_minutes=60`
- ❌ **DO NOT** have `timeframe='1m'` for DXY (that's handled by calc_dxy_range_derived)

### Sample Expected Output:
```
canonical_symbol | timeframe | source_timeframe | run_interval_minutes | aggregation_delay_seconds | status | is_mandatory
-----------------|-----------|------------------|---------------------|---------------------------|--------|-------------
DXY              | 5m        | 1m              | 5                   | 300                       | idle   | true
DXY              | 1h        | 5m              | 60                  | 300                       | idle   | false
EURUSD           | 5m        | 1m              | 5                   | 120                       | idle   | false
EURUSD           | 1h        | 5m              | 60                  | 300                       | idle   | false
GBPUSD           | 5m        | 1m              | 5                   | 120                       | idle   | false
...
```

### Red Flags:
- ❌ DXY with `timeframe='1m'` exists
- ❌ Any symbol missing 5m or 1h entries
- ❌ Wrong `source_timeframe` (e.g., 5m task sourcing from 1h)
- ❌ Wrong `run_interval_minutes` (should match timeframe: 5m→5min, 1h→60min)

---

## 🔧 Required Actions Before Deployment

### 1. Patch Tick-Factory for DXY Derivation
- **File:** `apps/typescript/tick-factory/src/ingestindex.ts`
- **Action:** Add DXY calculation logic after FX ingestion
- **Estimated Time:** 30-45 minutes
- **Priority:** HIGH - Without this, DXY 1m bars won't be created

### 2. Verify data_agg_state Configuration
- **Action:** Run SQL query and verify task rows exist
- **Priority:** HIGH - Without proper tasks, aggregator won't process anything

### 3. Verify Source Data Exists
```sql
-- Check that you have source data to aggregate
SELECT canonical_symbol, timeframe, COUNT(*) as bar_count, 
       MIN(ts_utc) as earliest, MAX(ts_utc) as latest
FROM data_bars
WHERE timeframe IN ('1m', '5m')
  AND canonical_symbol IN ('XAUUSD', 'EURUSD', 'USDJPY', 'GBPUSD', 'USDCAD', 'USDSEK', 'USDCHF')
GROUP BY canonical_symbol, timeframe
ORDER BY canonical_symbol, timeframe;

-- Check DXY 1m data (should be empty until tick-factory patch is deployed)
SELECT COUNT(*) as dxy_1m_count, MIN(ts_utc) as earliest, MAX(ts_utc) as latest
FROM derived_data_bars
WHERE canonical_symbol = 'DXY' AND timeframe = '1m' AND deleted_at IS NULL;
```

---

## 📋 Deployment Sequence

Once all verifications pass:

1. **Deploy Tick-Factory DXY Patch** (if not already done)
   ```bash
   cd apps/typescript/tick-factory
   pnpm deploy:dev
   ```

2. **Wait for FX ingestion cycle to complete** (3-10 minutes)
   - Verify DXY 1m bars are being created in `derived_data_bars`

3. **Deploy Aggregator**
   ```bash
   cd apps/typescript/aggregator
   pnpm deploy:dev
   ```

4. **Monitor First Run**
   ```bash
   pnpm tail:dev
   ```

5. **Verify Results**
   ```sql
   -- Check aggregator run logs
   SELECT run_id, job_name, env_name, started_at, finished_at, status, stats
   FROM ops_runlog
   WHERE job_name = 'agg-master'
   ORDER BY started_at DESC
   LIMIT 5;

   -- Check aggregated bars
   SELECT canonical_symbol, timeframe, COUNT(*) as bars, 
          MIN(ts_utc) as earliest, MAX(ts_utc) as latest,
          AVG(quality_score) as avg_quality
   FROM derived_data_bars
   WHERE source = 'agg' AND deleted_at IS NULL
   GROUP BY canonical_symbol, timeframe
   ORDER BY canonical_symbol, timeframe;
   ```

---

## ⚠️ Known Limitations

1. **DXY 1m requires all 6 FX pairs** - If any FX pair is missing data, DXY won't be calculated for that timestamp
2. **Quality scores** - Bars with insufficient source candles get lower quality scores:
   - 1m→5m: Need 5 bars for quality=2, 4 bars for quality=1, 3 bars for quality=0
   - 5m→1h: Need 12 bars for quality=2, 10-11 for quality=1, 8-9 for quality=0, 7 for quality=-1
3. **Aggregation delay** - Default 5 minutes to allow source data to settle
4. **Auto-disable** - After 3 consecutive hard failures, tasks are automatically disabled

---

## 🎯 Success Criteria

Aggregator deployment is successful when:

- ✅ ops_runlog shows successful runs every 5 minutes
- ✅ derived_data_bars contains 5m and 1h bars for all configured symbols
- ✅ DXY 5m and 1h bars are present (sourced from DXY 1m)
- ✅ Quality scores are reasonable (mostly 2, some 1, minimal 0 or -1)
- ✅ No tasks stuck in 'running' status
- ✅ No unexpected hard failures or auto-disables
