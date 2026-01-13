# DXY Data Generation & Design Analysis

## Table of Contents
1. [Overview](#overview)
2. [DXY Components & Formula](#dxy-components--formula)
3. [Data Generation Flow](#data-generation-flow)
4. [1m Bar Generation (calc_dxy_range_derived)](#1m-bar-generation-calc_dxy_range_derived)
5. [5m/1h Data Derivation](#5m1h-data-derivation)
6. [Database Schema](#database-schema)
7. [Configuration & Setup](#configuration--setup)
8. [Backfill Process](#backfill-process)
9. [Monitoring & Validation](#monitoring--validation)
10. [Troubleshooting](#troubleshooting)

---

## Overview

DXY (US Dollar Index) is a **synthetic/derived asset** that is calculated from 6 FX pairs. Unlike regular assets (EURUSD, GOLD, etc.) that are fetched directly from market data APIs, DXY is **computed** from component pairs using a logarithmic formula.

### Key Characteristics:
- **Not ingested from API** - No direct market data source
- **Derived from 6 FX pairs**: EURUSD, USDJPY, GBPUSD, USDCAD, USDSEK, USDCHF
- **Calculated at 1m granularity** - Uses closing prices of 1m bars
- **Aggregated to 5m/1h** - Standard aggregation like other assets
- **Stored in derived_data_bars** - Separate from raw market data (data_bars table)
- **Uses mathematical formula** - Logarithmic weighted average

### Data Pipeline:
```
FX Pairs (1m bars in data_bars)
    ↓
calc_dxy_range_derived function
    ↓
DXY 1m bars (derived_data_bars)
    ↓
Aggregator (aggregate_1m_to_5m_window)
    ↓
DXY 5m bars (derived_data_bars)
    ↓
Aggregator (aggregate_5m_to_1h_window)
    ↓
DXY 1h bars (derived_data_bars)
```

---

## DXY Components & Formula

### The 6 FX Pairs (Weights)

DXY is calculated from these 6 USD-based currency pairs:

| Component | Canonical Symbol | Weight (%) | Role |
|-----------|-------------------|-----------|------|
| Euro | EURUSD | 57.6% | Dominant component |
| Japanese Yen | USDJPY | 13.6% | Second largest |
| British Pound | GBPUSD | 11.9% | Third |
| Canadian Dollar | USDCAD | 9.1% | Fourth |
| Swedish Krona | USDSEK | 4.2% | Fifth |
| Swiss Franc | USDCHF | 3.6% | Smallest |

**Total: 100.0%** ✓

### Mathematical Formula

The DXY calculation uses a **logarithmic, weighted geometric mean**:

```
DXY = 50.14348112 × 
      exp(-0.576 × ln(EURUSD)) × 
      exp( 0.136 × ln(USDJPY)) × 
      exp(-0.119 × ln(GBPUSD)) × 
      exp( 0.091 × ln(USDCAD)) × 
      exp( 0.042 × ln(USDSEK)) × 
      exp( 0.036 × ln(USDCHF))
```

### Why This Formula?

1. **Base Price Adjustment**: `50.14348112` is the base value to put DXY on a historical 0-100+ scale
2. **Logarithmic Transformation**: `exp(weight × ln(price))` = `price^weight`
   - Transforms multiplicative relationship to additive
   - Makes computation numerically stable
3. **Negative Weights for USD Inverse Pairs**:
   - EURUSD, GBPUSD: Negative exponents (when these rise, USD weakens)
   - USDJPY, USDCAD, USDSEK, USDCHF: Positive exponents (when these rise, USD strengthens)
4. **Equals 1.0 When All Pairs = 1.0**: Self-calibrating

### Example Calculation

For a timestamp with these component prices:
```
EURUSD:  1.0500
USDJPY:  108.50
GBPUSD:  1.2500
USDCAD:  1.3000
USDSEK:  10.1500
USDCHF:  0.9200
```

```
DXY = 50.14348112 × 
      exp(-0.576 × ln(1.0500)) × 
      exp( 0.136 × ln(108.50)) × 
      exp(-0.119 × ln(1.2500)) × 
      exp( 0.091 × ln(1.3000)) × 
      exp( 0.042 × ln(10.1500)) × 
      exp( 0.036 × ln(0.9200))
    = ~103.45
```

---

## Data Generation Flow

### Phase 1: FX Pair Ingestion (Tick-Factory)

**Where**: `apps/typescript/tick-factory/src/ingestindex.ts` → `runIngestAB()`

**Process**:
1. Worker scheduled to run every 5 minutes (cron job)
2. For each FX pair (EURUSD, USDJPY, GBPUSD, USDCAD, USDSEK, USDCHF):
   - Fetch 1m bars from Massive API
   - Insert/update into `data_bars` table (raw market data)
   - Track ingestion success

**Key Code Section** (~line 1434):
```typescript
// After successful ingestion of each FX pair
if (FX_PAIRS_FOR_DXY.has(canonical) && tf === '1m' && barRows.length > 0) {
  const windowKey = makeWindowKey(fromTs, safeTo);
  
  if (!fxWindowsIngested.has(windowKey)) {
    fxWindowsIngested.set(windowKey, new Set());
  }
  fxWindowsIngested.get(windowKey)!.add(canonical);
  
  const ingestedForWindow = fxWindowsIngested.get(windowKey)!;
  
  // When ALL 6 pairs are present for this time window
  if (ingestedForWindow.size === 6) {
    // Trigger DXY calculation
    const dxyResult = await supa.rpc("calc_dxy_range_derived", {
      p_from_utc: toIso(fromTs),
      p_to_utc: toIso(safeTo),
      p_tf: "1m",
      p_derivation_version: 1,
    });
  }
}
```

**Time Window**: A "window" is defined by the from/to timestamps of the ingestion batch
- Typically 5 minutes of data in a single call
- When all 6 pairs ingested for the same window → DXY calculation triggered

### Phase 2: DXY 1m Derivation (calc_dxy_range_derived)

**Where**: PostgreSQL function `calc_dxy_range_derived()`

**Signature**:
```sql
calc_dxy_range_derived(
  p_from_utc timestamptz,
  p_to_utc timestamptz,
  p_tf text default '1m',
  p_derivation_version int default 1
)
```

**Parameters**:
- `p_from_utc`: Start timestamp (UTC)
- `p_to_utc`: End timestamp (UTC)
- `p_tf`: Timeframe (locked to '1m' only)
- `p_derivation_version`: Version number (currently 1)

**Returns** (JSON):
```json
{
  "success": true,
  "inserted": 240,
  "updated": 5,
  "skipped_incomplete": 0
}
```

**Logic** (Pseudocode):

```sql
1. WITH base AS (
     SELECT unique timestamps from data_bars
     WHERE symbol IN (6 FX pairs)
       AND timeframe = '1m'
       AND ts_utc BETWEEN p_from_utc AND p_to_utc
   )

2. WITH c AS (
     SELECT timestamp,
            EURUSD_close,
            USDJPY_close,
            GBPUSD_close,
            USDCAD_close,
            USDSEK_close,
            USDCHF_close
     FROM base JOIN data_bars on FX components
   )

3. WITH valid AS (
     SELECT * FROM c
     WHERE ALL prices > 0  -- validation check
   )

4. WITH dxy AS (
     SELECT timestamp,
            calc_dxy_formula(prices) AS dxy_close
     FROM valid
   )

5. INSERT INTO derived_data_bars
    (canonical_symbol='DXY', timeframe='1m', ts_utc, open/high/low/close=dxy_close, ...)
   ON CONFLICT UPDATE  -- update if already exists
   RETURNING inserted_flag

6. RETURN {inserted count, updated count, skipped count}
```

**Key Behaviors**:
- **Upsert Logic**: If DXY bar already exists for timestamp, UPDATE it instead of error
- **Incomplete Windows**: If any of the 6 pairs missing for a timestamp → skip (counted in `skipped_incomplete`)
- **Quality Score**: Set to 2 (excellent) when all 6 components present
- **Source**: Marked as 'dxy' in source column
- **Derivation Version**: Tracked for auditing

### Phase 3: 5m/1h Aggregation (Aggregator)

**Where**: Aggregator worker (Python) → `aggregate_1m_to_5m_window()`, `aggregate_5m_to_1h_window()`

**Process** (for DXY and other assets):
1. Aggregator scheduler checks `data_agg_state` for pending tasks
2. For each 5m time window that needs aggregation:
   - Read all 1m bars (from both `data_bars` and `derived_data_bars`)
   - Calculate OHLC from 5 constituent 1m bars
   - Insert 5m bar into `derived_data_bars`
3. For each 1h time window:
   - Read all 5m bars
   - Calculate OHLC from 12 constituent 5m bars
   - Insert 1h bar into `derived_data_bars`

**Critical SQL** (from `aggregate_1m_to_5m_window`):
```sql
WITH src AS (
  SELECT ts_utc, open, high, low, close, vol, vwap, trade_count 
  FROM data_bars
  WHERE symbol = 'DXY' AND timeframe = '1m' AND ts_utc >= from AND ts_utc < to
  
  UNION ALL  -- ← THIS IS KEY: includes DXY 1m bars from derived_data_bars
  
  SELECT ts_utc, open, high, low, close, vol, vwap, trade_count 
  FROM derived_data_bars
  WHERE symbol = 'DXY' AND timeframe = '1m' AND ts_utc >= from AND ts_utc < to
)
SELECT 
  min(open) as open,
  max(high) as high,
  min(low) as low,
  max(close) as close,
  sum(vol) as vol
FROM src
WHERE ts_utc >= window_start AND ts_utc < window_end
GROUP BY window
```

---

## 1m Bar Generation (calc_dxy_range_derived)

### Detailed SQL Implementation

```sql
CREATE OR REPLACE FUNCTION calc_dxy_range_derived(
  p_from_utc timestamptz, 
  p_to_utc timestamptz, 
  p_tf text default '1m', 
  p_derivation_version int default 1
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE 
  v_inserted int := 0;
  v_updated int := 0;
  v_skipped int := 0;
BEGIN
  -- Enforce 1m only
  IF p_tf <> '1m' THEN 
    RAISE EXCEPTION 'DXY locked to 1m only';
  END IF;

  -- Step 1: Find all unique timestamps with all 6 FX pairs
  WITH base AS (
    SELECT ts_utc
    FROM data_bars
    WHERE timeframe='1m' 
      AND ts_utc >= p_from_utc 
      AND ts_utc < p_to_utc
      AND canonical_symbol IN ('EURUSD','USDJPY','GBPUSD','USDCAD','USDSEK','USDCHF')
    GROUP BY ts_utc
  ),
  
  -- Step 2: Extract prices for each component
  c AS (
    SELECT b.ts_utc,
      MAX(close) FILTER (WHERE canonical_symbol='EURUSD') as eurusd,
      MAX(close) FILTER (WHERE canonical_symbol='USDJPY') as usdjpy,
      MAX(close) FILTER (WHERE canonical_symbol='GBPUSD') as gbpusd,
      MAX(close) FILTER (WHERE canonical_symbol='USDCAD') as usdcad,
      MAX(close) FILTER (WHERE canonical_symbol='USDSEK') as usdsek,
      MAX(close) FILTER (WHERE canonical_symbol='USDCHF') as usdchf
    FROM base b
    JOIN data_bars d ON d.ts_utc = b.ts_utc 
      AND d.timeframe='1m'
      AND d.canonical_symbol IN ('EURUSD','USDJPY','GBPUSD','USDCAD','USDSEK','USDCHF')
    GROUP BY b.ts_utc
  ),
  
  -- Step 3: Keep only rows with all 6 components valid (>0)
  valid AS (
    SELECT * FROM c
    WHERE eurusd > 0 
      AND usdjpy > 0 
      AND gbpusd > 0 
      AND usdcad > 0 
      AND usdsek > 0 
      AND usdchf > 0
  ),
  
  -- Step 4: Calculate DXY using formula
  dxy AS (
    SELECT ts_utc,
      (50.14348112
        * exp(-0.576 * ln(eurusd))
        * exp( 0.136 * ln(usdjpy))
        * exp(-0.119 * ln(gbpusd))
        * exp( 0.091 * ln(usdcad))
        * exp( 0.042 * ln(usdsek))
        * exp( 0.036 * ln(usdchf))
      ) as dxy_close
    FROM valid
  ),
  
  -- Step 5: Upsert into derived_data_bars
  up AS (
    INSERT INTO derived_data_bars (
      canonical_symbol, timeframe, ts_utc,
      open, high, low, close,
      vol, vwap, trade_count,
      is_partial, source, ingested_at,
      source_timeframe, source_candles, expected_candles, 
      quality_score, derivation_version, raw, deleted_at
    )
    SELECT 'DXY', '1m', ts_utc,
      dxy_close, dxy_close, dxy_close, dxy_close,  -- OHLC all same
      0, null, null,  -- vol, vwap, trade_count = null
      false, 'dxy', now(),  -- source = 'dxy'
      '1m', 6, 6,  -- source_timeframe='1m', 6 components, 6 expected
      2, p_derivation_version,  -- quality_score=2 (excellent)
      jsonb_build_object('kind','dxy','formula','standard'), null
    FROM dxy
    ON CONFLICT (canonical_symbol, timeframe, ts_utc) 
      WHERE (deleted_at IS NULL)
    DO UPDATE SET 
      close = excluded.close,
      open = excluded.open,
      high = excluded.high,
      low = excluded.low,
      derivation_version = excluded.derivation_version,
      raw = excluded.raw,
      updated_at = now()
    RETURNING (xmax = 0) as inserted  -- xmax=0 means new insert, >0 means update
  )
  
  -- Step 6: Count results
  SELECT 
    COUNT(*) FILTER (WHERE inserted),
    COUNT(*) FILTER (WHERE NOT inserted)
  INTO v_inserted, v_updated
  FROM up;

  -- Count skipped timestamps (had some but not all 6 pairs)
  SELECT COUNT(*)
  INTO v_skipped
  FROM (
    SELECT ts_utc FROM base 
    EXCEPT 
    SELECT ts_utc FROM valid
  ) s;

  RETURN jsonb_build_object(
    'success', true,
    'inserted', COALESCE(v_inserted, 0),
    'updated', COALESCE(v_updated, 0),
    'skipped_incomplete', COALESCE(v_skipped, 0)
  );
END $$;
```

### Key Points:

1. **Data Source**: Always reads from `data_bars` (raw ingested FX bars)
2. **Output Table**: Always writes to `derived_data_bars`
3. **OHLC Values**: All set to the calculated `dxy_close` (bar open=high=low=close)
4. **Metadata**:
   - `source_timeframe = '1m'` (source is 1m FX bars)
   - `source_candles = 6` (always 6 FX components)
   - `quality_score = 2` (excellent when all 6 present)
5. **Incomplete Handling**: 
   - Rows where ANY of 6 pairs are missing/invalid → skipped
   - Not inserted → counted in `skipped_incomplete`
6. **Upsert Behavior**:
   - If DXY 1m bar already exists for timestamp → UPDATE
   - If new → INSERT
   - This allows recalculation if FX data changes

---

## 5m/1h Data Derivation

### How 5m/1h Bars Are Created from DXY 1m

The aggregator process is **identical for DXY and other assets**. It uses UNION ALL to pull from both tables.

#### 5m Aggregation (`aggregate_1m_to_5m_window`)

**Input**: 5 × 1m bars (DXY or EURUSD, doesn't matter)
**Output**: 1 × 5m bar

```sql
WITH src AS (
  -- Raw market data
  SELECT ts_utc, open, high, low, close, vol, vwap, trade_count 
  FROM data_bars
  WHERE canonical_symbol = p_symbol 
    AND timeframe = '1m' 
    AND ts_utc >= p_from_utc 
    AND ts_utc < p_to_utc
  
  UNION ALL
  
  -- Synthetic data (includes DXY 1m bars)
  SELECT ts_utc, open, high, low, close, vol, vwap, trade_count 
  FROM derived_data_bars
  WHERE canonical_symbol = p_symbol 
    AND timeframe = '1m' 
    AND deleted_at IS NULL
    AND ts_utc >= p_from_utc 
    AND ts_utc < p_to_utc
)
SELECT 
  p_symbol as canonical_symbol,
  '5m' as timeframe,
  date_trunc('5m', ts_utc) as ts_utc,  -- Window start time
  (ARRAY_AGG(open ORDER BY ts_utc))[1] as open,  -- First bar's open
  MAX(high) as high,  -- Highest high of 5 bars
  MIN(low) as low,    -- Lowest low of 5 bars
  (ARRAY_AGG(close ORDER BY ts_utc DESC))[1] as close,  -- Last bar's close
  SUM(vol) as vol,
  null as vwap,
  SUM(trade_count) as trade_count,
  false as is_partial,
  'aggregation' as source,
  now() as ingested_at,
  '1m' as source_timeframe,
  5 as source_candles,
  5 as expected_candles,
  2 as quality_score
FROM src
WHERE ts_utc >= p_window_start 
  AND ts_utc < p_window_start + interval '5m'
GROUP BY date_trunc('5m', ts_utc);
```

**For DXY**: This query will pull DXY 1m bars from `derived_data_bars` (since they were inserted by `calc_dxy_range_derived`) and aggregate them.

#### 1h Aggregation (`aggregate_5m_to_1h_window`)

**Input**: 12 × 5m bars
**Output**: 1 × 1h bar

```sql
-- Same UNION ALL pattern
WITH src AS (
  SELECT ... FROM data_bars WHERE timeframe = '5m'
  UNION ALL
  SELECT ... FROM derived_data_bars WHERE timeframe = '5m'
)
SELECT 
  5m bars aggregated to 1h OHLC
```

### Why UNION ALL?

The `UNION ALL` is **critical for DXY**:
- DXY 1m bars are in `derived_data_bars` (not `data_bars`)
- Without UNION ALL, aggregator would miss DXY 1m data
- With UNION ALL, both table sources are combined seamlessly
- Aggregator doesn't care where data comes from - treats all 1m bars equally

---

## Database Schema

### Tables Involved

#### 1. `data_bars` (Raw Market Data)

```sql
CREATE TABLE data_bars (
  id bigserial PRIMARY KEY,
  canonical_symbol VARCHAR(20) NOT NULL,
  timeframe VARCHAR(3) NOT NULL,  -- '1m', '5m', '1h', etc.
  ts_utc TIMESTAMPTZ NOT NULL,
  
  -- OHLCV
  open DECIMAL(20,8),
  high DECIMAL(20,8),
  low DECIMAL(20,8),
  close DECIMAL(20,8),
  vol DECIMAL(20,8),
  
  -- Metadata
  vwap DECIMAL(20,8),
  trade_count BIGINT,
  is_partial BOOLEAN,
  source VARCHAR(50),  -- 'massive_api', 'ingest', etc.
  ingested_at TIMESTAMPTZ,
  
  -- Constraint
  UNIQUE(canonical_symbol, timeframe, ts_utc),
  CONSTRAINT data_bars_check_tf CHECK (timeframe IN ('1m'))
);

CREATE INDEX idx_data_bars_ts_utc ON data_bars(ts_utc);
CREATE INDEX idx_data_bars_symbol_tf_ts ON data_bars(canonical_symbol, timeframe, ts_utc);
```

**Note**: DXY has NO rows in `data_bars` (not ingested from API)

#### 2. `derived_data_bars` (Synthetic/Derived Data)

```sql
CREATE TABLE derived_data_bars (
  id bigserial PRIMARY KEY,
  canonical_symbol VARCHAR(20) NOT NULL,
  timeframe VARCHAR(3) NOT NULL,  -- '1m', '5m', '1h', '1d'
  ts_utc TIMESTAMPTZ NOT NULL,
  
  -- OHLCV
  open DECIMAL(20,8),
  high DECIMAL(20,8),
  low DECIMAL(20,8),
  close DECIMAL(20,8),
  vol DECIMAL(20,8),
  
  -- Metadata
  vwap DECIMAL(20,8),
  trade_count BIGINT,
  is_partial BOOLEAN,
  source VARCHAR(50),  -- 'dxy', 'aggregation'
  ingested_at TIMESTAMPTZ,
  source_timeframe VARCHAR(3),  -- What we aggregated from
  source_candles INT,  -- How many source candles
  expected_candles INT,  -- How many we expect
  quality_score INT,  -- 0-2 (poor/good/excellent)
  
  derivation_version INT,
  raw JSONB,  -- Extra metadata
  deleted_at TIMESTAMPTZ,  -- Soft delete
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Constraints
  UNIQUE(canonical_symbol, timeframe, ts_utc) WHERE (deleted_at IS NULL),
  CHECK (timeframe IN ('1m', '5m', '1h', '1d')),
  CHECK (quality_score >= 0 AND quality_score <= 2)
);

CREATE INDEX idx_derived_bars_ts_utc ON derived_data_bars(ts_utc);
CREATE INDEX idx_derived_bars_symbol_tf_ts ON derived_data_bars(canonical_symbol, timeframe, ts_utc);
CREATE INDEX idx_derived_bars_source ON derived_data_bars(source);
```

**DXY Data Location**:
- **DXY 1m**: `derived_data_bars` with `source='dxy'`, `timeframe='1m'`
- **DXY 5m**: `derived_data_bars` with `source='aggregation'`, `timeframe='5m'`
- **DXY 1h**: `derived_data_bars` with `source='aggregation'`, `timeframe='1h'`

### Example Queries

**Check DXY 1m bars:**
```sql
SELECT ts_utc, open, high, low, close, quality_score, source, created_at
FROM derived_data_bars
WHERE canonical_symbol = 'DXY' 
  AND timeframe = '1m'
  AND deleted_at IS NULL
ORDER BY ts_utc DESC
LIMIT 20;
```

**Count DXY bars by timeframe:**
```sql
SELECT timeframe, COUNT(*) as bar_count, MIN(ts_utc) as earliest, MAX(ts_utc) as latest
FROM derived_data_bars
WHERE canonical_symbol = 'DXY' AND deleted_at IS NULL
GROUP BY timeframe
ORDER BY timeframe;
```

**Check component dependency (all 6 FX pairs present for each DXY minute):**
```sql
WITH dxy_minutes AS (
  SELECT ts_utc
  FROM derived_data_bars
  WHERE canonical_symbol = 'DXY' AND timeframe = '1m'
),
component_check AS (
  SELECT 
    d.ts_utc,
    COUNT(DISTINCT b.canonical_symbol) as components_present
  FROM dxy_minutes d
  LEFT JOIN data_bars b ON b.ts_utc = d.ts_utc 
    AND b.timeframe = '1m'
    AND b.canonical_symbol IN ('EURUSD','USDJPY','GBPUSD','USDCAD','USDSEK','USDCHF')
  GROUP BY d.ts_utc
)
SELECT 
  COUNT(*) FILTER (WHERE components_present = 6) as dxy_minutes_with_all_components,
  COUNT(*) FILTER (WHERE components_present < 6) as dxy_minutes_with_missing_components,
  COUNT(*) as total_dxy_minutes
FROM component_check;
```

---

## Configuration & Setup

### Does DXY Need core_assets_register_all Entry?

**Short Answer**: Not really. DXY is synthetic and can work without an explicit registry entry, BUT having one is recommended for operational clarity.

### Option 1: WITHOUT Registry Entry (Current)

If DXY is NOT in `core_assets_register_all`:
- ✅ DXY 1m bars still generate (via `calc_dxy_range_derived`)
- ✅ Aggregator still processes 5m/1h (task exists in `data_agg_state`)
- ❌ Can't pause/resume DXY via UI/scripts (no `data_ingest_state` row)
- ❌ Dashboard might not list DXY as "managed asset"
- ❌ Freshness checks need special handling

### Option 2: WITH Registry Entry (Recommended)

**Add to core_assets_register_all**:
```sql
INSERT INTO core_assets_register_all (
  canonical_symbol,
  asset_class,
  description,
  active,
  test_active,
  created_at,
  updated_at
) VALUES (
  'DXY',
  'currency_index',
  'US Dollar Index - synthetic asset derived from 6 FX pairs',
  true,
  true,
  NOW(),
  NOW()
);
```

**Benefits**:
- ✅ Listed in asset inventory
- ✅ Can use pause/resume feature
- ✅ Freshness monitoring includes DXY
- ✅ Dashboard treats consistently
- ✅ Access control properly scoped

### data_agg_state Configuration

**IMPORTANT**: DXY should have tasks for 5m and 1h aggregation ONLY.

```sql
-- 5m aggregation (from 1m DXY bars)
INSERT INTO data_agg_state (
  canonical_symbol,
  timeframe,
  source_timeframe,
  run_interval_minutes,
  aggregation_delay_seconds,
  is_mandatory,
  status
) VALUES (
  'DXY',
  '5m',
  '1m',
  5,  -- Run every 5 minutes
  300,  -- 5 minute delay
  true,  -- Critical task
  'idle'
);

-- 1h aggregation (from 5m DXY bars)
INSERT INTO data_agg_state (
  canonical_symbol,
  timeframe,
  source_timeframe,
  run_interval_minutes,
  aggregation_delay_seconds,
  is_mandatory,
  status
) VALUES (
  'DXY',
  '1h',
  '5m',
  60,  -- Run every 60 minutes
  300,  -- 5 minute delay
  false,
  'idle'
);

-- DO NOT CREATE DXY 1m entry (handled by calc_dxy_range_derived)
```

### Verify Configuration

```sql
-- Check task configuration
SELECT canonical_symbol, timeframe, source_timeframe, 
       run_interval_minutes, is_mandatory, status
FROM data_agg_state
WHERE canonical_symbol = 'DXY'
ORDER BY timeframe;

-- Expected output:
-- DXY | 5m | 1m | 5 | true | idle
-- DXY | 1h | 5m | 60 | false | idle
```

---

## Backfill Process

### Backfilling Historical DXY 1m Data

DXY 1m bars can be backfilled using the `calc_dxy_range_derived` function directly.

#### Option 1: Using SQL

```sql
-- Backfill DXY for a specific date range
SELECT calc_dxy_range_derived(
  '2025-01-01 00:00:00 UTC'::timestamptz,
  '2025-01-02 00:00:00 UTC'::timestamptz,
  '1m',
  1
);

-- Result:
-- {"success":true,"inserted":1440,"updated":0,"skipped_incomplete":3}
```

#### Option 2: Batch Backfill Script

Create a Python script to backfill in daily chunks:

```python
import psycopg2
from datetime import datetime, timedelta

def backfill_dxy(start_date, end_date, db_url):
    """Backfill DXY 1m bars for date range"""
    conn = psycopg2.connect(db_url)
    cursor = conn.cursor()
    
    current = start_date
    while current < end_date:
        next_day = current + timedelta(days=1)
        
        from_utc = current.isoformat() + ' UTC'
        to_utc = next_day.isoformat() + ' UTC'
        
        cursor.execute(
            "SELECT calc_dxy_range_derived(%s, %s, '1m', 1)",
            (from_utc, to_utc)
        )
        
        result = cursor.fetchone()[0]
        print(f"{current.date()}: {result}")
        
        current = next_day
    
    conn.commit()
    cursor.close()
    conn.close()

# Usage
backfill_dxy(
    datetime(2025, 1, 1),
    datetime(2025, 1, 31),
    'postgresql://...'
)
```

#### Option 3: Manual Backfill Steps

1. **Check if FX components exist** for your date range:
```sql
SELECT DISTINCT ts_utc::DATE
FROM data_bars
WHERE canonical_symbol IN ('EURUSD','USDJPY','GBPUSD','USDCAD','USDSEK','USDCHF')
  AND timeframe = '1m'
  AND ts_utc >= '2025-01-01'
  AND ts_utc < '2025-02-01'
GROUP BY ts_utc::DATE
ORDER BY ts_utc DESC;
```

2. **For each day that has data**, call the derivation function:
```sql
DO $$
DECLARE
  v_date DATE;
  v_result JSONB;
BEGIN
  FOR v_date IN 
    SELECT DISTINCT ts_utc::DATE
    FROM data_bars
    WHERE canonical_symbol IN ('EURUSD','USDJPY','GBPUSD','USDCAD','USDSEK','USDCHF')
      AND timeframe = '1m'
      AND ts_utc >= '2025-01-01'::timestamptz
      AND ts_utc < '2025-02-01'::timestamptz
    ORDER BY ts_utc DESC
  LOOP
    v_result := calc_dxy_range_derived(
      (v_date AT TIME ZONE 'UTC')::timestamptz,
      ((v_date + 1) AT TIME ZONE 'UTC')::timestamptz,
      '1m',
      1
    );
    
    RAISE NOTICE 'Date %, Result: %', v_date, v_result;
  END LOOP;
END $$;
```

3. **Verify backfilled data**:
```sql
SELECT 
  canonical_symbol,
  timeframe,
  COUNT(*) as bar_count,
  MIN(ts_utc) as earliest,
  MAX(ts_utc) as latest,
  MAX(close) as max_price,
  MIN(close) as min_price
FROM derived_data_bars
WHERE canonical_symbol = 'DXY'
GROUP BY canonical_symbol, timeframe
ORDER BY timeframe;
```

### Important Notes

1. **Requires FX Data**: Backfill only works if FX 1m bars already exist in `data_bars`
2. **Idempotent**: Running backfill multiple times is safe (upserts existing data)
3. **Performance**: Processing ~1,440 minutes per day (1m bars)
4. **Missing Components**: Timestamps without all 6 FX pairs are skipped

---

## Monitoring & Validation

### Real-Time Monitoring

#### 1. Check DXY Generation Status

```sql
-- Latest DXY 1m bars
SELECT 
  ts_utc,
  close,
  quality_score,
  source,
  derivation_version,
  created_at
FROM derived_data_bars
WHERE canonical_symbol = 'DXY' AND timeframe = '1m'
ORDER BY ts_utc DESC
LIMIT 50;
```

#### 2. Monitor Tick-Factory Logs

```bash
# Watch for DXY derivation logs
cd apps/typescript/tick-factory
pnpm tail:dev | grep -i dxy

# Expected log messages:
# [DXY_TRACK] FX pair ingested for window
# [DXY_DERIVE_START] All 6 FX pairs ready
# [DXY_DERIVE_SUCCESS] DXY derived successfully
# [DXY_DERIVE_ERROR] DXY derivation failed
```

#### 3. Check Aggregator Task Status

```sql
-- Are 5m/1h aggregation tasks running?
SELECT 
  canonical_symbol,
  timeframe,
  status,
  last_attempted_at_utc,
  last_successful_at_utc,
  last_agg_bar_ts_utc,
  hard_fail_streak
FROM data_agg_state
WHERE canonical_symbol = 'DXY'
ORDER BY timeframe;
```

#### 4. Monitor Data Freshness

```sql
-- How fresh is DXY data?
WITH latest_bars AS (
  SELECT 
    canonical_symbol,
    timeframe,
    MAX(ts_utc) as latest_ts,
    COUNT(*) as bar_count
  FROM derived_data_bars
  WHERE canonical_symbol = 'DXY' AND deleted_at IS NULL
  GROUP BY canonical_symbol, timeframe
)
SELECT 
  canonical_symbol,
  timeframe,
  latest_ts,
  (NOW() AT TIME ZONE 'UTC') - latest_ts as staleness,
  bar_count
FROM latest_bars
ORDER BY timeframe;

-- Example output:
-- DXY | 1m | 2025-01-13 14:25:00 UTC | 5 mins | 145,000
-- DXY | 5m | 2025-01-13 14:25:00 UTC | 5 mins | 29,000
-- DXY | 1h | 2025-01-13 14:00:00 UTC | 25 mins | 4,850
```

### Data Validation Tests

#### Test 1: Component Dependency

```sql
-- Verify each DXY 1m bar has all 6 FX components available
WITH dxy_bars AS (
  SELECT DISTINCT ts_utc
  FROM derived_data_bars
  WHERE canonical_symbol = 'DXY' AND timeframe = '1m'
),
component_check AS (
  SELECT 
    d.ts_utc,
    COUNT(DISTINCT b.canonical_symbol) as components_found,
    SUM(CASE WHEN b.close <= 0 THEN 1 ELSE 0 END) as invalid_prices
  FROM dxy_bars d
  LEFT JOIN data_bars b ON b.ts_utc = d.ts_utc 
    AND b.timeframe = '1m'
    AND b.canonical_symbol IN ('EURUSD','USDJPY','GBPUSD','USDCAD','USDSEK','USDCHF')
  GROUP BY d.ts_utc
)
SELECT 
  COUNT(*) as minutes_checked,
  COUNT(*) FILTER (WHERE components_found = 6) as with_all_components,
  COUNT(*) FILTER (WHERE components_found < 6) as missing_components,
  COUNT(*) FILTER (WHERE invalid_prices > 0) as with_invalid_prices,
  MIN(components_found) as min_components,
  MAX(components_found) as max_components
FROM component_check;
```

**Expected Result**:
```
minutes_checked | with_all_components | missing_components | with_invalid_prices
145000          | 145000              | 0                  | 0
```

#### Test 2: DXY Formula Validation

```sql
-- Manually verify a DXY calculation
WITH sample_ts AS (
  SELECT ts_utc
  FROM derived_data_bars
  WHERE canonical_symbol = 'DXY' AND timeframe = '1m'
  ORDER BY ts_utc DESC
  LIMIT 1
),
component_prices AS (
  SELECT 
    ts_utc,
    MAX(close) FILTER (WHERE canonical_symbol='EURUSD') as eurusd,
    MAX(close) FILTER (WHERE canonical_symbol='USDJPY') as usdjpy,
    MAX(close) FILTER (WHERE canonical_symbol='GBPUSD') as gbpusd,
    MAX(close) FILTER (WHERE canonical_symbol='USDCAD') as usdcad,
    MAX(close) FILTER (WHERE canonical_symbol='USDSEK') as usdsek,
    MAX(close) FILTER (WHERE canonical_symbol='USDCHF') as usdchf
  FROM data_bars, sample_ts
  WHERE data_bars.ts_utc = sample_ts.ts_utc 
    AND timeframe = '1m'
    AND canonical_symbol IN ('EURUSD','USDJPY','GBPUSD','USDCAD','USDSEK','USDCHF')
  GROUP BY ts_utc
),
calculated_dxy AS (
  SELECT 
    ts_utc,
    eurusd, usdjpy, gbpusd, usdcad, usdsek, usdchf,
    (50.14348112
      * exp(-0.576 * ln(eurusd))
      * exp( 0.136 * ln(usdjpy))
      * exp(-0.119 * ln(gbpusd))
      * exp( 0.091 * ln(usdcad))
      * exp( 0.042 * ln(usdsek))
      * exp( 0.036 * ln(usdchf))
    ) as calculated_dxy
  FROM component_prices
)
SELECT 
  c.ts_utc,
  c.eurusd, c.usdjpy, c.gbpusd, c.usdcad, c.usdsek, c.usdchf,
  c.calculated_dxy,
  d.close as stored_dxy,
  ABS(c.calculated_dxy - d.close) as difference,
  ABS(c.calculated_dxy - d.close) / d.close * 100 as pct_error
FROM calculated_dxy c
JOIN derived_data_bars d ON d.ts_utc = c.ts_utc 
  AND d.canonical_symbol = 'DXY' 
  AND d.timeframe = '1m';
```

**Expected Result**: `pct_error` should be < 0.0001% (floating point rounding only)

#### Test 3: Aggregation Continuity

```sql
-- Check if 5m aggregation is continuous (no gaps)
WITH dxy_5m_bars AS (
  SELECT ts_utc
  FROM derived_data_bars
  WHERE canonical_symbol = 'DXY' AND timeframe = '5m'
  ORDER BY ts_utc
),
gaps AS (
  SELECT 
    ts_utc,
    LEAD(ts_utc) OVER (ORDER BY ts_utc) as next_ts_utc,
    EXTRACT(EPOCH FROM (LEAD(ts_utc) OVER (ORDER BY ts_utc) - ts_utc)) / 60 as gap_minutes
  FROM dxy_5m_bars
)
SELECT 
  COUNT(*) as total_5m_bars,
  COUNT(*) FILTER (WHERE gap_minutes = 5) as normal_gaps,
  COUNT(*) FILTER (WHERE gap_minutes != 5) as abnormal_gaps,
  COUNT(*) FILTER (WHERE gap_minutes > 60) as large_gaps,
  MIN(gap_minutes) as min_gap,
  MAX(gap_minutes) as max_gap
FROM gaps;
```

#### Test 4: Price Reasonableness

```sql
-- Check DXY price ranges (should be roughly 70-110)
SELECT 
  COUNT(*) as bar_count,
  MIN(close) as min_price,
  MAX(close) as max_price,
  AVG(close) as avg_price,
  STDDEV(close) as price_stddev,
  COUNT(*) FILTER (WHERE close < 50 OR close > 150) as unrealistic_prices
FROM derived_data_bars
WHERE canonical_symbol = 'DXY' AND timeframe = '1m' AND deleted_at IS NULL;
```

---

## Troubleshooting

### Problem 1: DXY 1m Bars Not Being Generated

#### Symptoms
- DXY 1m rows in `derived_data_bars` are missing or stale
- Aggregator can't create 5m/1h bars (blocked by missing 1m source)

#### Investigation Steps

1. **Check if FX data is being ingested**:
```sql
SELECT 
  canonical_symbol,
  timeframe,
  COUNT(*) as bar_count,
  MAX(ts_utc) as latest
FROM data_bars
WHERE canonical_symbol IN ('EURUSD','USDJPY','GBPUSD','USDCAD','USDSEK','USDCHF')
  AND timeframe = '1m'
GROUP BY canonical_symbol, timeframe
ORDER BY canonical_symbol;
```
If counts are zero or stale → **FX ingestion is broken**, not DXY derivation.

2. **Check tick-factory logs**:
```bash
cd apps/typescript/tick-factory
pnpm tail:dev 2>&1 | grep -E "DXY|EURUSD|INGEST"
```
Look for:
- `DXY_TRACK` messages (FX pairs being tracked)
- `DXY_DERIVE_START` (all 6 pairs ready)
- `DXY_DERIVE_ERROR` (failures)

3. **Manually run DXY derivation**:
```sql
-- Trigger derivation for last 1 hour
SELECT calc_dxy_range_derived(
  NOW() - interval '1 hour',
  NOW(),
  '1m',
  1
);
```
Check the result JSON:
- `success: true` → function worked, check row counts
- `inserted > 0` → bars being created
- `skipped_incomplete > 0` → some timestamps missing FX pairs

4. **Check for errors in the function itself**:
```sql
-- Wrap in exception handler to see error
DO $$
BEGIN
  PERFORM calc_dxy_range_derived(
    NOW() - interval '1 hour',
    NOW(),
    '1m',
    1
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Error: %', SQLERRM;
END $$;
```

#### Solution

| Root Cause | Fix |
|-----------|-----|
| FX data stale | Check FX ingestion, restart tick-factory worker |
| Function not called | Verify tick-factory patch is deployed (check `ingestindex.ts` line ~1566) |
| Missing FX pairs | Wait for all 6 pairs to ingest in same window, or manually call function |
| DB permissions | Ensure service_role has execute permission on `calc_dxy_range_derived` |

---

### Problem 2: DXY 5m/1h Bars Not Being Created

#### Symptoms
- DXY 1m bars exist, but 5m/1h bars are missing
- Aggregator logs show failures for DXY 5m task

#### Investigation Steps

1. **Check aggregator task configuration**:
```sql
SELECT * FROM data_agg_state 
WHERE canonical_symbol = 'DXY';
```
Should have:
- Row for `5m` with `source_timeframe = '1m'`
- Row for `1h` with `source_timeframe = '5m'`
- NO row for `1m` (that's generated by calc_dxy_range_derived)

2. **Check task status**:
```sql
SELECT 
  canonical_symbol, timeframe, status, 
  last_attempted_at_utc, last_successful_at_utc,
  last_error
FROM data_agg_state
WHERE canonical_symbol = 'DXY';
```
- `status = 'idle'` → ready to run
- `status = 'running'` → currently executing
- `status = 'disabled'` → task is paused
- `last_error` populated → previous failure

3. **Check if DXY 1m bars are readable by aggregator**:
```sql
-- Aggregator queries data_bars UNION ALL derived_data_bars
-- Simulate what aggregator sees:
WITH src AS (
  SELECT ts_utc, close FROM data_bars 
  WHERE canonical_symbol = 'DXY' AND timeframe = '1m'
  UNION ALL
  SELECT ts_utc, close FROM derived_data_bars 
  WHERE canonical_symbol = 'DXY' AND timeframe = '1m' AND deleted_at IS NULL
)
SELECT COUNT(*) FROM src;
```
Should return > 0.

4. **Manually trigger aggregation**:
```sql
-- Run aggregation function directly
SELECT aggregate_1m_to_5m_window(
  'DXY',
  '1m',
  NOW()::DATE || ' 14:00:00'::time AT TIME ZONE 'UTC',
  NOW()::DATE || ' 14:05:00'::time AT TIME ZONE 'UTC'
);
```

#### Solution

| Root Cause | Fix |
|-----------|-----|
| Task not configured | Add DXY 5m and 1h rows to `data_agg_state` |
| Task disabled | `UPDATE data_agg_state SET status='idle' WHERE canonical_symbol='DXY'` |
| DXY 1m bars missing | Fix DXY 1m generation first (see Problem 1) |
| Function error | Check aggregator logs for specific SQL errors |

---

### Problem 3: DXY Values Look Wrong

#### Symptoms
- DXY prices are 0, negative, or unreasonably high/low
- Price movements don't correlate with FX pairs

#### Investigation Steps

1. **Check component prices at sample timestamp**:
```sql
SELECT 
  canonical_symbol,
  ts_utc,
  close
FROM data_bars
WHERE ts_utc = '2025-01-13 14:00:00 UTC'
  AND canonical_symbol IN ('EURUSD','USDJPY','GBPUSD','USDCAD','USDSEK','USDCHF')
  AND timeframe = '1m'
ORDER BY canonical_symbol;
```

2. **Manually calculate DXY for that timestamp**:
```sql
WITH prices AS (
  SELECT 
    '2025-01-13 14:00:00 UTC'::timestamptz as ts,
    MAX(close) FILTER (WHERE canonical_symbol='EURUSD') as eurusd,
    MAX(close) FILTER (WHERE canonical_symbol='USDJPY') as usdjpy,
    MAX(close) FILTER (WHERE canonical_symbol='GBPUSD') as gbpusd,
    MAX(close) FILTER (WHERE canonical_symbol='USDCAD') as usdcad,
    MAX(close) FILTER (WHERE canonical_symbol='USDSEK') as usdsek,
    MAX(close) FILTER (WHERE canonical_symbol='USDCHF') as usdchf
  FROM data_bars
  WHERE ts_utc = '2025-01-13 14:00:00 UTC'
    AND timeframe = '1m'
    AND canonical_symbol IN ('EURUSD','USDJPY','GBPUSD','USDCAD','USDSEK','USDCHF')
)
SELECT 
  eurusd, usdjpy, gbpusd, usdcad, usdsek, usdchf,
  (50.14348112
    * exp(-0.576 * ln(eurusd))
    * exp( 0.136 * ln(usdjpy))
    * exp(-0.119 * ln(gbpusd))
    * exp( 0.091 * ln(usdcad))
    * exp( 0.042 * ln(usdsek))
    * exp( 0.036 * ln(usdchf))
  ) as calculated_dxy
FROM prices;
```

3. **Compare with stored value**:
```sql
SELECT close FROM derived_data_bars
WHERE canonical_symbol = 'DXY' AND ts_utc = '2025-01-13 14:00:00 UTC' AND timeframe = '1m';
```

#### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| DXY = 0 | Missing or NULL prices | Check component data quality, ensure all prices > 0 |
| DXY < 50 | Invalid formula | Formula weights inverted? Check exp() signs |
| DXY > 120 | Formula issue | Same as above |
| Matches manually | Data is correct | Formula is working as designed |

#### Solution

If formula is correct and components are valid, the issue is likely data quality in FX pairs.
Run validation scripts from [Validation Tests](#data-validation-tests) section.

---

### Problem 4: Performance Issues

#### Symptoms
- DXY derivation takes too long
- Tick-factory worker times out or gets rate-limited
- Database CPU spikes during derivation

#### Investigation Steps

1. **Check derivation query performance**:
```sql
EXPLAIN ANALYZE
SELECT calc_dxy_range_derived(
  NOW() - interval '1 day',
  NOW(),
  '1m',
  1
);
```
Look for sequential scans of large tables. Should use indexes.

2. **Monitor database load**:
```sql
SELECT pid, query, duration, state
FROM pg_stat_activity
WHERE query LIKE '%calc_dxy%' OR query LIKE '%derived_data_bars%'
ORDER BY duration DESC;
```

#### Solution

| Optimization | Impact |
|--------------|--------|
| Index on `data_bars(canonical_symbol, timeframe, ts_utc)` | Critical |
| Index on `derived_data_bars(ts_utc)` | Important |
| Partition tables by ts_utc | For large datasets |
| Batch derivation into smaller date ranges | Reduces peak load |
| Run derivation off-peak | Spreads load |

---

## Q&A: Common Configuration Questions

### Q1: Do I need a record in `core_assets_register_all` for DXY?

**Answer**: **No, but it's highly recommended.**

DXY can function without a `core_assets_register_all` entry because:
- DXY 1m generation is triggered by the tick-factory worker after FX pair ingestion
- The `calc_dxy_range_derived` function doesn't check the registry
- Aggregator tasks in `data_agg_state` don't require a registry entry to run

**However**, adding a registry entry is **recommended** for:

✅ **Operational visibility**:
- DXY appears in asset inventory dashboards
- Monitoring tools recognize DXY as a managed asset
- Freshness checks include DXY automatically

✅ **Access control**:
- Proper scoping of DXY in security policies
- Consistent treatment across environments (dev/test/prod)

✅ **Pause/resume functionality**:
- Can use pause/resume scripts with DXY
- Consistent asset management UX

**Recommended SQL**:
```sql
INSERT INTO core_assets_register_all (
  canonical_symbol,
  asset_class,
  description,
  active,
  test_active,
  created_at,
  updated_at
) VALUES (
  'DXY',
  'currency_index',
  'US Dollar Index - synthetic asset derived from 6 FX pairs',
  true,
  true,
  NOW(),
  NOW()
)
ON CONFLICT (canonical_symbol) DO NOTHING;
```

---

### Q2: Do I need records in `data_agg_state` for derived DXY data?

**Answer**: **Yes, but ONLY for 5m and 1h timeframes.**

#### ✅ Required Entries:

**1. DXY 5m aggregation** (1m → 5m):
```sql
INSERT INTO data_agg_state (
  canonical_symbol,
  timeframe,
  source_timeframe,
  run_interval_minutes,
  aggregation_delay_seconds,
  is_mandatory,
  status
) VALUES (
  'DXY',
  '5m',
  '1m',             -- Source is DXY 1m bars from derived_data_bars
  5,                -- Run every 5 minutes
  300,              -- 5 minute delay
  true,             -- Critical task
  'idle'
)
ON CONFLICT (canonical_symbol, timeframe) DO NOTHING;
```

**2. DXY 1h aggregation** (5m → 1h):
```sql
INSERT INTO data_agg_state (
  canonical_symbol,
  timeframe,
  source_timeframe,
  run_interval_minutes,
  aggregation_delay_seconds,
  is_mandatory,
  status
) VALUES (
  'DXY',
  '1h',
  '5m',             -- Source is DXY 5m bars from derived_data_bars
  60,               -- Run every 60 minutes
  300,              -- 5 minute delay
  false,
  'idle'
)
ON CONFLICT (canonical_symbol, timeframe) DO NOTHING;
```

#### ❌ DO NOT CREATE:

**DXY 1m entry** - This is handled by `calc_dxy_range_derived`:
```sql
-- ❌ DO NOT DO THIS:
INSERT INTO data_agg_state (canonical_symbol, timeframe, ...) 
VALUES ('DXY', '1m', ...);  -- WRONG! This will cause conflicts
```

**Why?** DXY 1m bars are generated by the tick-factory worker calling `calc_dxy_range_derived`, NOT by the aggregator. Having a 1m entry in `data_agg_state` would cause:
- Confusion about which process owns DXY 1m generation
- Potential race conditions
- Aggregator trying to aggregate "nothing to 1m" (no source)

#### Verification:

```sql
-- Should return exactly 2 rows: 5m and 1h
SELECT canonical_symbol, timeframe, source_timeframe, 
       run_interval_minutes, is_mandatory, status
FROM data_agg_state
WHERE canonical_symbol = 'DXY'
ORDER BY timeframe;

-- Expected output:
-- DXY | 5m | 1m | 5  | true  | idle
-- DXY | 1h | 5m | 60 | false | idle
```

---

### Q3: Do I need records in `data_ingest_state` for 1m or 5m derived data?

**Answer**: **No. DXY is not ingested, it's derived.**

#### Why No `data_ingest_state` Entry?

`data_ingest_state` tracks **API ingestion** for assets that are fetched from external data providers (Massive API). It manages:
- Ingestion cursor (last timestamp fetched)
- API fetch status
- Pause/resume for API calls
- Backfill state

**DXY is synthetic** - it's calculated from existing FX data, not fetched from an API. Therefore:

❌ **No `data_ingest_state` for DXY 1m**:
- DXY 1m is calculated by `calc_dxy_range_derived` function
- Triggered by tick-factory after FX pair ingestion
- No API to fetch from

❌ **No `data_ingest_state` for DXY 5m**:
- DXY 5m is aggregated from DXY 1m by the aggregator
- Controlled by `data_agg_state`, not `data_ingest_state`
- No API to fetch from

❌ **No `data_ingest_state` for DXY 1h**:
- DXY 1h is aggregated from DXY 5m by the aggregator
- Controlled by `data_agg_state`, not `data_ingest_state`
- No API to fetch from

#### What DOES Need `data_ingest_state`?

The **6 FX component pairs** that DXY depends on:

```sql
-- These should exist (they're ingested from API):
SELECT canonical_symbol, timeframe, status, pause_fetch
FROM data_ingest_state
WHERE canonical_symbol IN ('EURUSD', 'USDJPY', 'GBPUSD', 'USDCAD', 'USDSEK', 'USDCHF')
  AND timeframe = '1m'
ORDER BY canonical_symbol;

-- Expected: 6 rows (one for each FX pair)
```

#### Summary Table:

| Asset | 1m Ingestion | 1m Derivation | 5m Aggregation | 1h Aggregation |
|-------|-------------|---------------|----------------|----------------|
| **EURUSD** | `data_ingest_state` ✅ | N/A | `data_agg_state` ✅ | `data_agg_state` ✅ |
| **USDJPY** | `data_ingest_state` ✅ | N/A | `data_agg_state` ✅ | `data_agg_state` ✅ |
| **GBPUSD** | `data_ingest_state` ✅ | N/A | `data_agg_state` ✅ | `data_agg_state` ✅ |
| **USDCAD** | `data_ingest_state` ✅ | N/A | `data_agg_state` ✅ | `data_agg_state` ✅ |
| **USDSEK** | `data_ingest_state` ✅ | N/A | `data_agg_state` ✅ | `data_agg_state` ✅ |
| **USDCHF** | `data_ingest_state` ✅ | N/A | `data_agg_state` ✅ | `data_agg_state` ✅ |
| **DXY** | ❌ No API | `calc_dxy_range_derived` (via tick-factory) | `data_agg_state` ✅ | `data_agg_state` ✅ |

#### Key Insight:

- **Regular assets**: `data_ingest_state` (1m) → `data_bars` table → `data_agg_state` (5m, 1h) → `derived_data_bars` table
- **DXY**: FX components (1m) → `calc_dxy_range_derived` → `derived_data_bars` table (1m) → `data_agg_state` (5m, 1h) → `derived_data_bars` table (5m, 1h)

---

## Summary

### Key Takeaways

1. **DXY is Synthetic**: Not fetched from API, calculated from 6 FX pairs
2. **Three-Stage Pipeline**:
   - **Tick-Factory**: Ingests FX pairs, triggers `calc_dxy_range_derived` when all 6 available
   - **calc_dxy_range_derived**: SQL function that calculates 1m DXY bars using logarithmic formula
   - **Aggregator**: Uses UNION ALL to combine data sources, aggregates 1m→5m→1h

3. **Data Location**:
   - FX pairs: `data_bars` table
   - DXY 1m: `derived_data_bars` table (source='dxy')
   - DXY 5m/1h: `derived_data_bars` table (source='aggregation')

4. **Configuration**:
   - `data_agg_state`: Must have 5m and 1h entries for DXY (not 1m)
   - `core_assets_register_all`: Optional but recommended for consistency

5. **Monitoring**:
   - Watch for `DXY_DERIVE_SUCCESS`/`ERROR` logs in tick-factory
   - Check `data_agg_state` for aggregation task status
   - Validate component dependency (all 6 FX pairs present)
   - Monitor freshness (should be within 5 minutes of real-time)

### Validation Checklist

- [ ] FX pairs ingesting successfully (EURUSD, USDJPY, GBPUSD, USDCAD, USDSEK, USDCHF)
- [ ] Tick-factory has DXY derivation logic implemented (around line 1566 in ingestindex.ts)
- [ ] `calc_dxy_range_derived` function exists and is executable
- [ ] DXY 1m bars exist in `derived_data_bars` with source='dxy'
- [ ] `data_agg_state` has DXY 5m and 1h tasks (not 1m)
- [ ] Aggregator is processing DXY 5m/1h tasks
- [ ] Component dependency is 100% (all 6 FX pairs present for each DXY minute)
- [ ] DXY prices are reasonable (roughly 70-120)
- [ ] No stale data (freshness within target SLA)

