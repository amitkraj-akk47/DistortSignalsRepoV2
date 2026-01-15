# DXY Architecture Migration - Precise Implementation Plan

**Date**: January 13, 2025  
**Owner**: Amit  
**Status**: Ready for Execution  
**Duration**: 3-4 hours (phased execution)  
**Risk Level**: Low (Option B transition for 24h safety margin)  
**Reversibility**: Full rollback possible at any phase

---

## Executive Summary

This document defines the **exact, sequenced steps** to migrate DXY 1-minute bars from `derived_data_bars` to `data_bars`, enabling a cleaner signal engine architecture.

**Scope**: Single asset migration, Option B (dual-write transition for 24h safety).

### Why Now?
- **Before** signal engine is built (hard to refactor after)
- **Simple** scope (single asset migration)
- **High payoff** (removes UNION ALL queries, semantic clarity)

### Key Outcomes
| Metric | Before | After |
|--------|--------|-------|
| 1m data sources | 2 tables (UNION ALL) | 1 table (clean) |
| Signal engine complexity | Complex query logic | Simple SELECT |
| Semantic meaning | Blurred | Explicit |

### Migration Strategy: Option B (Recommended)
- **Day 1**: Dual-write (new RPC writes to `data_bars`, old data kept in `derived_data_bars`)
- **Day 2**: Aggregator reads only from `data_bars`, verify 24h health
- **Day 3**: Soft-delete legacy DXY 1m from `derived_data_bars`, clean up

---

## Phase 1: Pre-Migration Safety (30 mins)

### 1.1 Environment Check
```bash
# Verify database connectivity
psql $DATABASE_URL -c "SELECT version();" 

# Check current state
psql $DATABASE_URL -c "
SELECT 
  'data_bars' as table_name,
  COUNT(*) as rows,
  COUNT(*) FILTER (WHERE canonical_symbol='DXY' AND timeframe='1m') as dxy_1m
FROM data_bars

UNION ALL

SELECT 
  'derived_data_bars',
  COUNT(*),
  COUNT(*) FILTER (WHERE canonical_symbol='DXY' AND timeframe='1m' AND deleted_at IS NULL)
FROM derived_data_bars;
"
```

### 1.2 Create Backup
```bash
# Full backup of both tables
pg_dump -h $DB_HOST -U $DB_USER -d $DB_NAME \
  -t data_bars -t derived_data_bars \
  --file=backup_pre_dxy_migration_$(date +%Y%m%d_%H%M%S).sql

# Verify backup is readable
head -50 backup_pre_dxy_migration_*.sql
```

### 1.3 Pre-Migration Snapshot
```sql
-- Document exact state before any changes
CREATE TEMPORARY TABLE pre_migration_snapshot AS
SELECT 
  'data_bars' as table_name,
  canonical_symbol,
  timeframe,
  COUNT(*) as row_count,
  MIN(ts_utc) as earliest,
  MAX(ts_utc) as latest,
  COUNT(*) FILTER (WHERE source='massive') as source_massive,
  COUNT(*) FILTER (WHERE source='ingest') as source_ingest
FROM data_bars
WHERE canonical_symbol IN ('DXY', 'EURUSD', 'USDJPY')
GROUP BY 1, canonical_symbol, timeframe

UNION ALL

SELECT 
  'derived_data_bars',
  canonical_symbol,
  timeframe,
  COUNT(*),
  MIN(ts_utc),
  MAX(ts_utc),
  0,
  0
FROM derived_data_bars
WHERE canonical_symbol IN ('DXY', 'EURUSD', 'USDJPY')
  AND deleted_at IS NULL
GROUP BY 1, canonical_symbol, timeframe;

-- Save snapshot for comparison
\COPY pre_migration_snapshot TO PROGRAM 'cat > pre_migration_snapshot.csv'
```

### 1.4 Verify Invariants
```sql
-- Check: data_bars uniqueness constraint exists
SELECT constraint_name, table_name, column_name
FROM information_schema.key_column_usage
WHERE table_name = 'data_bars'
  AND constraint_name LIKE '%unique%';
-- Expected: UNIQUE(canonical_symbol, timeframe, ts_utc)

-- Check: No existing DXY 1m in data_bars
SELECT COUNT(*)
FROM data_bars
WHERE canonical_symbol = 'DXY' AND timeframe = '1m';
-- Expected: 0 (or very few)

-- Check: source constraint on data_bars
SELECT constraint_name, constraint_definition
FROM information_schema.check_constraints
WHERE table_name = 'data_bars'
  AND constraint_name LIKE '%source%';
-- Current: likely CHECK (source IN ('massive_api', 'ingest'))
-- Will need to add 'synthetic' or 'dxy'
```

### Exit Criteria for Phase 1
- ✅ Backup file created and verified
- ✅ Pre-migration snapshot stored
- ✅ All invariants confirmed (uniqueness, constraints)
- ✅ Database connectivity stable
- ✅ No active ingestion happening (optional: pause workers)

---

## Phase 2: Schema & Function Updates (45 mins)

### 2.1 Update `data_bars` to Allow Synthetic Source

**File**: SQL migration (run directly)

```sql
BEGIN;

-- ============================================================================
-- STEP 1: Widen source constraint
-- ============================================================================

-- Drop existing constraint (save old definition first)
SELECT constraint_name, constraint_definition
FROM information_schema.check_constraints
WHERE table_name = 'data_bars' AND constraint_name LIKE '%source%';

-- Drop it
ALTER TABLE data_bars DROP CONSTRAINT IF EXISTS data_bars_source_check;

-- Add new constraint allowing synthetic
ALTER TABLE data_bars
ADD CONSTRAINT data_bars_source_check 
CHECK (source IN ('massive_api', 'ingest', 'synthetic'));

\echo '✓ Updated data_bars source constraint'

-- ============================================================================
-- STEP 2: Verify schema completeness
-- ============================================================================

-- Ensure data_bars has all columns needed for synthetic data
DO $$
BEGIN
  -- raw column (for metadata)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'data_bars' AND column_name = 'raw'
  ) THEN
    ALTER TABLE data_bars ADD COLUMN raw JSONB DEFAULT '{}'::JSONB;
    RAISE NOTICE '✓ Added raw column to data_bars';
  ELSE
    RAISE NOTICE '✓ raw column already exists';
  END IF;
  
  -- created_at (audit)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'data_bars' AND column_name = 'created_at'
  ) THEN
    ALTER TABLE data_bars ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW();
    RAISE NOTICE '✓ Added created_at column';
  ELSE
    RAISE NOTICE '✓ created_at column already exists';
  END IF;
  
  -- updated_at (audit)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'data_bars' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE data_bars ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
    RAISE NOTICE '✓ Added updated_at column';
  ELSE
    RAISE NOTICE '✓ updated_at column already exists';
  END IF;
END $$;

-- ============================================================================
-- STEP 3: Ensure proper indexing
-- ============================================================================

-- Unique constraint on (canonical_symbol, timeframe, ts_utc)
CREATE UNIQUE INDEX IF NOT EXISTS data_bars_unique_idx
ON data_bars(canonical_symbol, timeframe, ts_utc);

\echo '✓ Verified indexes'

COMMIT;
```

### 2.2 Rewrite DXY Derivation Function

**File**: SQL migration (replaces old `calc_dxy_range_derived`)

```sql
BEGIN;

\echo '=== Rewriting calc_dxy_range_1m function ==='

-- ============================================================================
-- New DXY 1m derivation function
-- Writes to data_bars instead of derived_data_bars
-- ============================================================================

CREATE OR REPLACE FUNCTION calc_dxy_range_1m(
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
  v_inserted int := 0;
  v_updated int := 0;
  v_skipped int := 0;
BEGIN
  -- Enforce 1m only
  IF p_from_utc >= p_to_utc THEN
    RAISE EXCEPTION 'Invalid timestamp range: from (%) >= to (%)', p_from_utc, p_to_utc;
  END IF;

  -- Step 1: Find all timestamps with complete FX 6-tuple
  WITH base_timestamps AS (
    SELECT DISTINCT ts_utc
    FROM data_bars
    WHERE timeframe = '1m'
      AND ts_utc >= p_from_utc
      AND ts_utc < p_to_utc
      AND canonical_symbol IN ('EURUSD', 'USDJPY', 'GBPUSD', 'USDCAD', 'USDSEK', 'USDCHF')
  ),

  -- Step 2: Pivot FX prices for each timestamp
  fx_prices AS (
    SELECT 
      b.ts_utc,
      MAX(d.close) FILTER (WHERE d.canonical_symbol = 'EURUSD') as eurusd,
      MAX(d.close) FILTER (WHERE d.canonical_symbol = 'USDJPY') as usdjpy,
      MAX(d.close) FILTER (WHERE d.canonical_symbol = 'GBPUSD') as gbpusd,
      MAX(d.close) FILTER (WHERE d.canonical_symbol = 'USDCAD') as usdcad,
      MAX(d.close) FILTER (WHERE d.canonical_symbol = 'USDSEK') as usdsek,
      MAX(d.close) FILTER (WHERE d.canonical_symbol = 'USDCHF') as usdchf
    FROM base_timestamps b
    JOIN data_bars d ON d.ts_utc = b.ts_utc
      AND d.timeframe = '1m'
      AND d.canonical_symbol IN ('EURUSD', 'USDJPY', 'GBPUSD', 'USDCAD', 'USDSEK', 'USDCHF')
    GROUP BY b.ts_utc
  ),

  -- Step 3: Keep only complete 6-tuples (all prices > 0 and NOT NULL)
  valid_tuples AS (
    SELECT *
    FROM fx_prices
    WHERE eurusd > 0 AND eurusd IS NOT NULL
      AND usdjpy > 0 AND usdjpy IS NOT NULL
      AND gbpusd > 0 AND gbpusd IS NOT NULL
      AND usdcad > 0 AND usdcad IS NOT NULL
      AND usdsek > 0 AND usdsek IS NOT NULL
      AND usdchf > 0 AND usdchf IS NOT NULL
  ),

  -- Step 4: Calculate DXY using logarithmic formula
  dxy_bars AS (
    SELECT 
      ts_utc,
      (
        50.14348112
        * exp(-0.576 * ln(eurusd))
        * exp( 0.136 * ln(usdjpy))
        * exp(-0.119 * ln(gbpusd))
        * exp( 0.091 * ln(usdcad))
        * exp( 0.042 * ln(usdsek))
        * exp( 0.036 * ln(usdchf))
      )::DECIMAL(20,8) as dxy_price
    FROM valid_tuples
  ),

  -- Step 5: Upsert into data_bars (CHANGED FROM derived_data_bars)
  upserted AS (
    INSERT INTO data_bars (
      canonical_symbol,
      timeframe,
      ts_utc,
      open,
      high,
      low,
      close,
      vol,
      vwap,
      trade_count,
      is_partial,
      source,
      ingested_at,
      raw,
      created_at,
      updated_at
    )
    SELECT 
      'DXY',
      '1m',
      ts_utc,
      dxy_price,
      dxy_price,
      dxy_price,
      dxy_price,
      0,                                    -- No volume for index
      NULL,                                 -- No VWAP
      0,                                    -- No trade count
      false,                                -- Not partial
      'synthetic',                          -- Source: synthetic
      NOW(),
      jsonb_build_object(
        'kind', 'dxy',
        'derivation_version', p_derivation_version,
        'components', jsonb_build_array('EURUSD', 'USDJPY', 'GBPUSD', 'USDCAD', 'USDSEK', 'USDCHF'),
        'formula_base', 50.14348112
      ),
      NOW(),
      NOW()
    FROM dxy_bars
    ON CONFLICT (canonical_symbol, timeframe, ts_utc)
    DO UPDATE SET
      open = EXCLUDED.open,
      high = EXCLUDED.high,
      low = EXCLUDED.low,
      close = EXCLUDED.close,
      source = EXCLUDED.source,
      raw = EXCLUDED.raw,
      updated_at = NOW()
    RETURNING (xmax = 0) as is_insert
  )

  SELECT 
    COUNT(*) FILTER (WHERE is_insert),
    COUNT(*) FILTER (WHERE NOT is_insert)
  INTO v_inserted, v_updated
  FROM upserted;

  -- Count skipped (incomplete tuples)
  WITH all_ts AS (
    SELECT ts_utc FROM base_timestamps
  ),
  valid_ts AS (
    SELECT ts_utc FROM valid_tuples
  )
  SELECT COUNT(*)
  INTO v_skipped
  FROM (SELECT ts_utc FROM all_ts EXCEPT SELECT ts_utc FROM valid_ts) x;

  RETURN jsonb_build_object(
    'success', true,
    'inserted', COALESCE(v_inserted, 0),
    'updated', COALESCE(v_updated, 0),
    'skipped_incomplete', COALESCE(v_skipped, 0),
    'derivation_version', p_derivation_version,
    'timestamp_range', jsonb_build_object(
      'from', p_from_utc,
      'to', p_to_utc
    )
  );

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'calc_dxy_range_1m failed: %', SQLERRM;
  RETURN jsonb_build_object(
    'success', false,
    'error', SQLERRM,
    'inserted', 0,
    'updated', 0,
    'skipped_incomplete', 0
  );
END;
$$;

\echo '✓ Created calc_dxy_range_1m function (writes to data_bars)'

COMMIT;
```

### 2.3 Update Asset Registry Entry

**File**: SQL migration

```sql
BEGIN;

\echo '=== Updating core_asset_registry_all ==='

INSERT INTO core_asset_registry_all (
  canonical_symbol,
  asset_class,
  description,
  active,
  test_active,
  metadata,
  created_at,
  updated_at
) VALUES (
  'DXY',
  'currency_index',
  'US Dollar Index - derived from 6 FX pairs (EURUSD, USDJPY, GBPUSD, USDCAD, USDSEK, USDCHF)',
  true,
  true,
  jsonb_build_object(
    'is_synthetic', true,
    'data_location', 'data_bars',
    'base_timeframe', '1m',
    'derivation_method', 'calc_dxy_range_1m',
    'derivation_formula', 'logarithmic_weighted_geometric_mean',
    'components', jsonb_build_array('EURUSD', 'USDJPY', 'GBPUSD', 'USDCAD', 'USDSEK', 'USDCHF'),
    'component_weights', jsonb_build_object(
      'EURUSD', -0.576,
      'USDJPY', 0.136,
      'GBPUSD', -0.119,
      'USDCAD', 0.091,
      'USDSEK', 0.042,
      'USDCHF', 0.036
    ),
    'derived_timeframes', jsonb_build_array('5m', '1h'),
    'migration_date', CURRENT_DATE,
    'migration_version', 1
  ),
  NOW(),
  NOW()
)
ON CONFLICT (canonical_symbol)
DO UPDATE SET
  description = EXCLUDED.description,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

\echo '✓ Updated DXY asset registry entry'

COMMIT;
```

### Exit Criteria for Phase 2
- ✅ `data_bars` source constraint allows 'synthetic'
- ✅ `data_bars` has raw, created_at, updated_at columns
- ✅ Unique index on (canonical_symbol, timeframe, ts_utc) exists
- ✅ `calc_dxy_range_1m()` function created
- ✅ Asset registry entry updated with new metadata
- ✅ No errors in logs

---

## Phase 3: Data Migration (45 mins)

### 3.1 Migrate Historical DXY 1m Bars

**File**: SQL migration

```sql
BEGIN;

\echo '=== Migrating historical DXY 1m bars ==='

-- ============================================================================
-- STEP 1: Count source records
-- ============================================================================

DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM derived_data_bars
  WHERE canonical_symbol = 'DXY' 
    AND timeframe = '1m'
    AND deleted_at IS NULL;
  
  RAISE NOTICE 'Found % active DXY 1m bars in derived_data_bars', v_count;
  
  IF v_count = 0 THEN
    RAISE WARNING 'No DXY 1m bars to migrate. This is OK if they were already deleted.';
  END IF;
END $$;

-- ============================================================================
-- STEP 2: Insert historical DXY 1m into data_bars
-- ============================================================================

INSERT INTO data_bars (
  canonical_symbol,
  timeframe,
  ts_utc,
  open,
  high,
  low,
  close,
  vol,
  vwap,
  trade_count,
  is_partial,
  source,
  ingested_at,
  raw,
  created_at,
  updated_at
)
SELECT 
  canonical_symbol,
  timeframe,
  ts_utc,
  open,
  high,
  low,
  close,
  vol,
  vwap,
  trade_count,
  is_partial,
  'synthetic',                            -- Override source
  ingested_at,
  jsonb_build_object(
    'kind', 'dxy',
    'derivation_version', 1,
    'migrated_from', 'derived_data_bars'
  ),
  COALESCE(created_at, ingested_at),
  NOW()
FROM derived_data_bars
WHERE canonical_symbol = 'DXY' 
  AND timeframe = '1m'
  AND deleted_at IS NULL
ON CONFLICT (canonical_symbol, timeframe, ts_utc)
DO UPDATE SET
  open = EXCLUDED.open,
  high = EXCLUDED.high,
  low = EXCLUDED.low,
  close = EXCLUDED.close,
  vol = EXCLUDED.vol,
  vwap = EXCLUDED.vwap,
  trade_count = EXCLUDED.trade_count,
  source = EXCLUDED.source,
  raw = EXCLUDED.raw,
  updated_at = NOW();

\echo '✓ Migrated historical DXY 1m bars'

-- ============================================================================
-- STEP 3: Verify counts match
-- ============================================================================

DO $$
DECLARE
  v_derived_count INT;
  v_data_count INT;
BEGIN
  SELECT COUNT(*) INTO v_derived_count
  FROM derived_data_bars
  WHERE canonical_symbol = 'DXY' 
    AND timeframe = '1m'
    AND deleted_at IS NULL;
  
  SELECT COUNT(*) INTO v_data_count
  FROM data_bars
  WHERE canonical_symbol = 'DXY' 
    AND timeframe = '1m';
  
  RAISE NOTICE 'Count verification: derived=%, data_bars=%', v_derived_count, v_data_count;
  
  IF v_derived_count != v_data_count THEN
    RAISE EXCEPTION 'Mismatch! derived: %, data_bars: %', v_derived_count, v_data_count;
  END IF;
  
  RAISE NOTICE '✓ Counts match - migration successful';
END $$;

-- ============================================================================
-- STEP 4: Soft-delete source rows (keep audit trail)
-- ============================================================================

UPDATE derived_data_bars
SET deleted_at = NOW(), updated_at = NOW()
WHERE canonical_symbol = 'DXY' 
  AND timeframe = '1m'
  AND deleted_at IS NULL;

\echo '✓ Soft-deleted source DXY 1m bars in derived_data_bars'

COMMIT;
```

### 3.2 Verify Migration

**File**: SQL query (run immediately after migration)

```sql
\echo '=== Post-Migration Verification ==='

-- Check 1: DXY 1m exists in data_bars
SELECT 'data_bars 1m count' as check_name,
       COUNT(*) as value,
       'bars' as unit
FROM data_bars
WHERE canonical_symbol = 'DXY' AND timeframe = '1m'

UNION ALL

-- Check 2: Data range
SELECT 'data_bars 1m date range',
       EXTRACT(DAY FROM (MAX(ts_utc) - MIN(ts_utc))),
       'days'
FROM data_bars
WHERE canonical_symbol = 'DXY' AND timeframe = '1m'

UNION ALL

-- Check 3: Source field
SELECT 'synthetic source count',
       COUNT(*),
       'bars'
FROM data_bars
WHERE canonical_symbol = 'DXY' AND timeframe = '1m' AND source = 'synthetic'

UNION ALL

-- Check 4: Price reasonableness
SELECT 'DXY price range (min)',
       ROUND(MIN(close)::numeric, 2),
       'index points'
FROM data_bars
WHERE canonical_symbol = 'DXY' AND timeframe = '1m'

UNION ALL

SELECT 'DXY price range (max)',
       ROUND(MAX(close)::numeric, 2),
       'index points'
FROM data_bars
WHERE canonical_symbol = 'DXY' AND timeframe = '1m'

UNION ALL

-- Check 5: Old location (should be empty or deleted)
SELECT 'derived_data_bars active DXY 1m',
       COUNT(*),
       'bars'
FROM derived_data_bars
WHERE canonical_symbol = 'DXY' AND timeframe = '1m' AND deleted_at IS NULL;

-- Detailed verification
\echo ''
\echo '=== Detailed Status ==='

SELECT 
  'DXY 1m bars in data_bars' as metric,
  COUNT(*) as count,
  MIN(ts_utc) as earliest,
  MAX(ts_utc) as latest
FROM data_bars
WHERE canonical_symbol = 'DXY' AND timeframe = '1m'

UNION ALL

SELECT 
  'DXY 1m bars in derived (active)',
  COUNT(*),
  MIN(ts_utc),
  MAX(ts_utc)
FROM derived_data_bars
WHERE canonical_symbol = 'DXY' AND timeframe = '1m' AND deleted_at IS NULL

UNION ALL

SELECT 
  'DXY 1m bars in derived (deleted)',
  COUNT(*),
  MIN(ts_utc),
  MAX(ts_utc)
FROM derived_data_bars
WHERE canonical_symbol = 'DXY' AND timeframe = '1m' AND deleted_at IS NOT NULL;
```

### Exit Criteria for Phase 3
- ✅ All historical DXY 1m bars migrated to data_bars
- ✅ Count verification passes
- ✅ Source field set to 'synthetic'
- ✅ Price range is reasonable (80-120 typically)
- ✅ Old rows soft-deleted in derived_data_bars
- ✅ No NULL prices or other anomalies

---

## Phase 4: Application Code Updates (1-2 hours)

### 4.1 Update Tick Factory to Call New Function

**File**: `apps/python/shared/data_models/dxy_derivation.py` (or similar)

**Current code**:
```python
# OLD: Calls calc_dxy_range_derived which writes to derived_data_bars
def derive_dxy_for_window(from_ts: datetime, to_ts: datetime) -> dict:
    result = supabase.rpc(
        'calc_dxy_range_derived',
        {'p_from_utc': from_ts, 'p_to_utc': to_ts, 'p_tf': '1m'}
    ).execute()
    return result.data
```

**New code**:
```python
# NEW: Calls calc_dxy_range_1m which writes to data_bars
def derive_dxy_for_window(from_ts: datetime, to_ts: datetime) -> dict:
    """
    Derive DXY 1m bars and write to data_bars.
    
    After migration: DXY 1m is canonical, not derived.
    This function ensures new bars are available for aggregation.
    """
    result = supabase.rpc(
        'calc_dxy_range_1m',
        {
            'p_from_utc': from_ts.isoformat(),
            'p_to_utc': to_ts.isoformat(),
            'p_derivation_version': 1
        }
    ).execute()
    
    if not result.data.get('success', False):
        raise Exception(f"DXY derivation failed: {result.data.get('error', 'unknown')}")
    
    return result.data
```

### 4.2 Update Aggregator to Query from data_bars Only

**File**: `apps/python/aggregator/aggregate.py` (or wherever 1m queries live)

**Current code** (with UNION ALL):
```python
def get_source_bars_1m(symbol: str, from_ts: datetime, to_ts: datetime) -> List[dict]:
    """Get 1m bars for aggregation. Currently uses UNION ALL for DXY."""
    query = """
    SELECT ts_utc, open, high, low, close, vol, vwap, trade_count
    FROM data_bars
    WHERE canonical_symbol = %s
      AND timeframe = '1m'
      AND ts_utc >= %s
      AND ts_utc < %s
    
    UNION ALL
    
    SELECT ts_utc, open, high, low, close, vol, vwap, trade_count
    FROM derived_data_bars
    WHERE canonical_symbol = %s
      AND timeframe = '1m'
      AND deleted_at IS NULL
      AND ts_utc >= %s
      AND ts_utc < %s
    
    ORDER BY ts_utc
    """
    
    results = execute_query(
        query,
        (symbol, from_ts, to_ts, symbol, from_ts, to_ts)
    )
    return results
```

**New code** (clean, single source):
```python
def get_source_bars_1m(symbol: str, from_ts: datetime, to_ts: datetime) -> List[dict]:
    """
    Get 1m bars for aggregation.
    
    Post-migration: All 1m bars (including DXY synthetic) are in data_bars.
    No UNION ALL needed.
    """
    query = """
    SELECT ts_utc, open, high, low, close, vol, vwap, trade_count
    FROM data_bars
    WHERE canonical_symbol = %s
      AND timeframe = '1m'
      AND ts_utc >= %s
      AND ts_utc < %s
    ORDER BY ts_utc
    """
    
    results = execute_query(
        query,
        (symbol, from_ts, to_ts)
    )
    return results
```

### 4.3 Update Signal Engine Queries (Optional, for Cleanliness)

**File**: `apps/typescript/signal-engine/src/data-provider.ts` (or similar)

**New pattern**:
```typescript
export async function fetch1mBars(
  symbols: string[],
  fromTs: Date,
  toTs: Date
): Promise<BarData[]> {
  /**
   * After migration: DXY 1m is in data_bars alongside other 1m bars.
   * Signal engine can seamlessly query all assets in one place.
   */
  const { data, error } = await supabase
    .from('data_bars')
    .select('canonical_symbol, ts_utc, open, high, low, close, vol, source')
    .in('canonical_symbol', symbols)
    .eq('timeframe', '1m')
    .gte('ts_utc', fromTs.toISOString())
    .lt('ts_utc', toTs.toISOString())
    .order('canonical_symbol')
    .order('ts_utc');

  if (error) throw error;
  return data;
}

// Usage example - DXY included without special handling:
const bars = await fetch1mBars(
  ['EURUSD', 'GBPUSD', 'DXY', 'GOLD', 'BITCOIN'],  // All assets uniformly
  window.startTime,
  window.endTime
);
```

### Exit Criteria for Phase 4
- ✅ Tick factory updated (calls `calc_dxy_range_1m`)
- ✅ Aggregator updated (queries from `data_bars` only)
- ✅ Signal engine updated (no UNION ALL needed)
- ✅ Code compiles/type checks
- ✅ Unit tests pass
- ✅ Code review completed

---

## Phase 5: Testing & Validation (1 hour)

### 5.1 Unit Tests

**File**: Test suite for DXY derivation

```python
# Test: New function writes to data_bars
def test_calc_dxy_range_1m_writes_to_data_bars():
    from_ts = datetime(2025, 1, 13, 0, 0, 0, tzinfo=timezone.utc)
    to_ts = datetime(2025, 1, 13, 1, 0, 0, tzinfo=timezone.utc)
    
    result = derive_dxy_for_window(from_ts, to_ts)
    
    assert result['success'] == True
    assert result['inserted'] > 0 or result['updated'] > 0
    assert result['derivation_version'] == 1
    
    # Verify in data_bars
    count = query_single(
        "SELECT COUNT(*) FROM data_bars WHERE canonical_symbol='DXY' AND timeframe='1m' AND ts_utc >= %s AND ts_utc < %s",
        (from_ts, to_ts)
    )
    assert count > 0


# Test: Aggregator queries data_bars
def test_aggregator_1m_source():
    bars = get_source_bars_1m('DXY', datetime(2025, 1, 13, 0, 0), datetime(2025, 1, 13, 1, 0))
    
    assert len(bars) > 0
    assert all(bar['ts_utc'] is not None for bar in bars)
    assert all(bar['close'] > 0 for bar in bars)
    
    # Prices should be reasonable
    prices = [bar['close'] for bar in bars]
    assert min(prices) > 80
    assert max(prices) < 120


# Test: No UNION ALL in aggregator query
def test_aggregator_no_union_all(mock_db):
    get_source_bars_1m('EURUSD', datetime.now(), datetime.now() + timedelta(hours=1))
    
    # Verify the SQL executed does NOT contain UNION ALL
    query_executed = mock_db.last_query
    assert 'UNION ALL' not in query_executed
    assert 'data_bars' in query_executed
```

### 5.2 Integration Test

**File**: E2E test

```sql
-- Integration test: Full pipeline
BEGIN;

\echo '=== Integration Test: DXY Pipeline ==='

-- Step 1: Verify FX pairs are fresh
WITH fx_check AS (
  SELECT 
    canonical_symbol,
    COUNT(*) as bars,
    MAX(ts_utc) as latest
  FROM data_bars
  WHERE canonical_symbol IN ('EURUSD', 'USDJPY', 'GBPUSD', 'USDCAD', 'USDSEK', 'USDCHF')
    AND timeframe = '1m'
    AND ts_utc >= NOW() AT TIME ZONE 'UTC' - INTERVAL '1 hour'
  GROUP BY canonical_symbol
)
SELECT * FROM fx_check;

-- Step 2: Derive DXY for last hour
SELECT calc_dxy_range_1m(
  NOW() AT TIME ZONE 'UTC' - INTERVAL '1 hour',
  NOW() AT TIME ZONE 'UTC',
  1
) as derivation_result;

-- Step 3: Verify DXY bars were created
SELECT 
  COUNT(*) as new_dxy_bars,
  MIN(ts_utc) as earliest,
  MAX(ts_utc) as latest
FROM data_bars
WHERE canonical_symbol = 'DXY'
  AND timeframe = '1m'
  AND ts_utc >= NOW() AT TIME ZONE 'UTC' - INTERVAL '1 hour';

-- Step 4: Test aggregator query
SELECT 
  ts_utc,
  open, high, low, close, vol
FROM data_bars
WHERE canonical_symbol = 'DXY'
  AND timeframe = '1m'
  AND ts_utc >= NOW() AT TIME ZONE 'UTC' - INTERVAL '1 hour'
ORDER BY ts_utc DESC
LIMIT 5;

-- Step 5: Verify 5m aggregation can consume 1m DXY
-- (This assumes you have aggregation logic)

ROLLBACK;  -- Don't persist test data
```

### Exit Criteria for Phase 5
- ✅ All unit tests pass
- ✅ Integration test passes
- ✅ No regressions in existing aggregation
- ✅ DXY 5m/1h bars still being produced
- ✅ Price freshness within SLA

---

## Phase 6: Deployment & Monitoring (1-2 hours)

### 6.1 Deployment Checklist

```bash
#!/bin/bash

set -e

echo "=== DXY Migration Deployment Checklist ==="

# 1. Backup
echo "□ Taking backup..."
pg_dump -h $DB_HOST -U $DB_USER -d $DB_NAME \
  -t data_bars -t derived_data_bars \
  --file=backup_pre_deployment_$(date +%Y%m%d_%H%M%S).sql
echo "✓ Backup complete"

# 2. Migration (if not already done in Phase 3)
echo "□ Running schema migrations..."
psql $DATABASE_URL -f migrations/dxy_schema_updates.sql
echo "✓ Schema updated"

# 3. Data migration (if not already done)
echo "□ Migrating data..."
psql $DATABASE_URL -f migrations/dxy_data_migration.sql
echo "✓ Data migrated"

# 4. Code deployment
echo "□ Deploying application code..."
# Your deployment command here
# e.g., git push origin main && deploy-worker tick-factory
echo "✓ Code deployed"

# 5. Smoke test
echo "□ Running smoke tests..."
pytest tests/test_dxy_migration.py -v
echo "✓ Tests passed"

# 6. Restart workers
echo "□ Restarting workers..."
pm2 restart tick-factory aggregator
sleep 10
echo "✓ Workers restarted"

# 7. Verify logs
echo "□ Checking worker logs..."
pm2 logs tick-factory --lines 50 | head -20
pm2 logs aggregator --lines 50 | head -20

# 8. Verify data production
echo "□ Verifying new DXY bars..."
psql $DATABASE_URL -c "
  SELECT COUNT(*), MAX(ts_utc)
  FROM data_bars
  WHERE canonical_symbol='DXY' AND timeframe='1m'
    AND ts_utc > NOW() - INTERVAL '5 minutes';
"

echo ""
echo "=== Deployment Complete ==="
echo "Next: Monitor for 1 hour and validate freshness"
```

### 6.2 Post-Deployment Monitoring (30 mins)

```sql
-- Run every 5 minutes for first 30 minutes

\echo '=== DXY Post-Deployment Health Check ==='

-- Check 1: New bars being created
SELECT 
  'DXY 1m in last 5m' as metric,
  COUNT(*) as bar_count,
  CASE 
    WHEN COUNT(*) >= 3 THEN 'PASS (fresh)'
    WHEN COUNT(*) >= 1 THEN 'WARN (partial)'
    ELSE 'FAIL (stale)'
  END as status
FROM data_bars
WHERE canonical_symbol = 'DXY'
  AND timeframe = '1m'
  AND ts_utc > NOW() AT TIME ZONE 'UTC' - INTERVAL '5 minutes';

-- Check 2: No errors in FX components
SELECT 
  'FX components' as metric,
  COUNT(DISTINCT canonical_symbol) as pairs_present,
  CASE WHEN COUNT(DISTINCT canonical_symbol) = 6 THEN 'PASS' ELSE 'WARN' END as status
FROM data_bars
WHERE canonical_symbol IN ('EURUSD', 'USDJPY', 'GBPUSD', 'USDCAD', 'USDSEK', 'USDCHF')
  AND timeframe = '1m'
  AND ts_utc > NOW() AT TIME ZONE 'UTC' - INTERVAL '5 minutes';

-- Check 3: Price validation
SELECT 
  'DXY price range' as metric,
  ROUND(AVG(close)::numeric, 2) as avg_price,
  CASE 
    WHEN AVG(close) BETWEEN 80 AND 120 THEN 'PASS'
    ELSE 'FAIL'
  END as status
FROM data_bars
WHERE canonical_symbol = 'DXY'
  AND timeframe = '1m'
  AND ts_utc > NOW() AT TIME ZONE 'UTC' - INTERVAL '1 hour';

-- Check 4: Aggregation running
SELECT 
  'DXY 5m aggregation' as metric,
  COUNT(*) as bars_in_last_hour,
  MAX(ts_utc) as latest,
  CASE 
    WHEN MAX(ts_utc) > NOW() AT TIME ZONE 'UTC' - INTERVAL '10 minutes' THEN 'PASS'
    ELSE 'WARN'
  END as status
FROM derived_data_bars
WHERE canonical_symbol = 'DXY'
  AND timeframe = '5m'
  AND deleted_at IS NULL;

-- Check 5: No orphaned 1m data in derived_data_bars
SELECT 
  'Orphaned 1m in derived' as metric,
  COUNT(*) FILTER (WHERE deleted_at IS NULL) as active_rows,
  COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) as deleted_rows,
  CASE WHEN COUNT(*) FILTER (WHERE deleted_at IS NULL) = 0 THEN 'PASS' ELSE 'WARN' END as status
FROM derived_data_bars
WHERE canonical_symbol = 'DXY' AND timeframe = '1m';
```

### Exit Criteria for Phase 6
- ✅ Deployment completed without errors
- ✅ Workers restarted successfully
- ✅ New DXY 1m bars appearing in data_bars
- ✅ Health checks all PASS
- ✅ DXY 5m/1h aggregation continuing
- ✅ No error spikes in logs

---

## Phase 7: Rollback Plan (If Needed)

If any critical issue arises, execute this script immediately:

```sql
BEGIN;

\echo '=== DXY Migration Rollback ==='

-- 1. Stop new DXY creation in data_bars
-- (comment out or disable tick-factory DXY derivation)

-- 2. Un-delete DXY 1m rows in derived_data_bars
UPDATE derived_data_bars
SET deleted_at = NULL, updated_at = NOW()
WHERE canonical_symbol = 'DXY' 
  AND timeframe = '1m'
  AND deleted_at IS NOT NULL;

\echo '✓ Restored DXY 1m to derived_data_bars'

-- 3. Option: Remove DXY 1m from data_bars (or keep for reference)
-- DELETE FROM data_bars
-- WHERE canonical_symbol = 'DXY' AND timeframe = '1m'
--   AND source = 'synthetic'
--   AND created_at > '2025-01-13';

-- 4. Revert code to old RPC call
-- (update tick-factory to call calc_dxy_range_derived instead)

-- 5. Revert schema if needed
-- ALTER TABLE data_bars DROP CONSTRAINT data_bars_source_check;
-- ALTER TABLE data_bars ADD CONSTRAINT data_bars_source_check
--   CHECK (source IN ('massive_api', 'ingest'));

COMMIT;

\echo '✓ Rollback complete'
```

---

## Success Metrics

### Data Completeness
- [ ] DXY 1m bars in `data_bars`: >= 10,000 rows
- [ ] Latest DXY bar: < 5 minutes old
- [ ] Price range: 80-120 (typical)
- [ ] NULL prices: 0

### Architectural Clarity
- [ ] No UNION ALL in aggregator code
- [ ] Signal engine queries single table for 1m
- [ ] DXY metadata in `core_asset_registry_all`
- [ ] Code reviewed and approved

### Operational Stability
- [ ] No increase in error rates
- [ ] Aggregation latency unchanged
- [ ] DXY 5m/1h still produced on schedule
- [ ] All component pairs fresh

### Documentation
- [ ] Migration plan documented (this file)
- [ ] Code changes documented in PR
- [ ] Rollback procedure tested
- [ ] Runbook updated for future reference

---

## Timeline Summary

| Phase | Task | Duration | Cumulative |
|-------|------|----------|-----------|
| 1 | Pre-migration setup | 30 min | 30 min |
| 2 | Schema & functions | 45 min | 1 hr 15 min |
| 3 | Data migration | 45 min | 2 hr |
| 4 | Code updates | 1-2 hr | 3-4 hr |
| 5 | Testing | 1 hr | 4-5 hr |
| 6 | Deployment & monitoring | 1-2 hr | 5-7 hr |
| **Total** | | | **5-7 hours** |

**Recommended execution**: Split over 2-3 days
- **Day 1**: Phases 1-3 (3 hours, backup + migration)
- **Day 2**: Phase 4 (code review + testing)
- **Day 3**: Phase 5-6 (deployment + 24h monitoring)

---

## Sign-Off

- **Prepared by**: Amit
- **Date**: January 13, 2025
- **Status**: Ready for execution
- **Approval**: [To be filled]

---

## Appendix: Quick Reference

### Key SQL Functions
- `calc_dxy_range_1m(p_from_utc, p_to_utc, p_derivation_version)` → writes to `data_bars`

### Key Tables
- `data_bars`: All 1m bars (ingested + synthetic)
- `derived_data_bars`: All non-1m derived bars (5m, 1h, etc.)

### Key Changes
| Component | Before | After |
|-----------|--------|-------|
| DXY 1m location | `derived_data_bars` | `data_bars` |
| 1m aggregation source | UNION ALL (2 tables) | Single `data_bars` |
| DXY RPC | `calc_dxy_range_derived` | `calc_dxy_range_1m` |

### Verify Commands
```sql
-- Check DXY 1m is in data_bars
SELECT COUNT(*) FROM data_bars WHERE canonical_symbol='DXY' AND timeframe='1m';

-- Check freshness
SELECT MAX(ts_utc) FROM data_bars WHERE canonical_symbol='DXY' AND timeframe='1m';

-- Check no orphans in derived_data_bars
SELECT COUNT(*) FROM derived_data_bars WHERE canonical_symbol='DXY' AND timeframe='1m' AND deleted_at IS NULL;
```
