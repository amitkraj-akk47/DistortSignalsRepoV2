# DXY Architecture Migration - Final Execution Plan

**Date**: January 13, 2025  
**Status**: Ready for Execution  
**Duration**: 3-4 hours (split across 2-3 days)  
**Risk Level**: Low (Option B dual-write transition for 24h safety)  
**Reversibility**: Full rollback at any phase

---

## Critical Design Decision: Option B (Dual-Write Transition)

This plan uses **24-hour safety margin** to reduce rollback risk:

- **Day 1**: New RPC writes DXY 1m to `data_bars` (keep old `derived_data_bars` intact)
- **Day 2**: Aggregator reads from `data_bars` only, verify 24h health
- **Day 3**: Soft-delete legacy DXY from `derived_data_bars`, clean up

**Why**: If rollback is needed, no data is lost. Just revert code and old data still exists.

---

## Phase 1: Pre-Migration Checks (15 mins)

**Run exactly as written:**

```bash
#!/bin/bash
set -e

echo "=== DXY Migration Pre-Flight ==="

# 1. Test connectivity
psql $DATABASE_URL -c "SELECT version();" || exit 1

# 2. Backup both tables
pg_dump -h $DB_HOST -U $DB_USER -d $DB_NAME \
  -t data_bars -t derived_data_bars \
  -t core_asset_registry_all \
  --file=backup_pre_dxy_$(date +%Y%m%d_%H%M%S).sql
echo "✓ Backup created"

# 3. Capture pre-state
psql $DATABASE_URL << 'EOF'
-- Pre-migration snapshot
\echo '=== PRE-MIGRATION STATE ==='

SELECT 
  'DXY 1m in data_bars' as location,
  COUNT(*) as bar_count
FROM data_bars
WHERE canonical_symbol = 'DXY' AND timeframe = '1m'

UNION ALL

SELECT 
  'DXY 1m in derived (active)',
  COUNT(*)
FROM derived_data_bars
WHERE canonical_symbol = 'DXY' AND timeframe = '1m' AND deleted_at IS NULL

UNION ALL

SELECT 
  'DXY 5m in derived (active)',
  COUNT(*)
FROM derived_data_bars
WHERE canonical_symbol = 'DXY' AND timeframe = '5m' AND deleted_at IS NULL;

EOF

echo "✓ Pre-flight checks passed"
```

---

## Phase 2: Schema Validation (10 mins)

**Verify before making changes:**

```sql
-- Run this to understand current state (READ-ONLY)

-- Check 1: Source constraint
SELECT constraint_definition
FROM information_schema.check_constraints
WHERE table_name = 'data_bars' AND constraint_name LIKE '%source%'
\gset source_constraint =

-- Check 2: Unique index exists
SELECT EXISTS (
  SELECT 1 FROM pg_indexes
  WHERE tablename = 'data_bars'
    AND indexdef LIKE '%UNIQUE%'
    AND indexdef LIKE '%(canonical_symbol%'
) as has_unique_index
\gset unique_check =

-- Check 3: Required columns exist
SELECT 
  EXISTS(SELECT 1 FROM information_schema.columns 
    WHERE table_name='data_bars' AND column_name='raw') as has_raw,
  EXISTS(SELECT 1 FROM information_schema.columns 
    WHERE table_name='data_bars' AND column_name='created_at') as has_created_at,
  EXISTS(SELECT 1 FROM information_schema.columns 
    WHERE table_name='data_bars' AND column_name='updated_at') as has_updated_at
\gset columns_check =

\echo 'Source constraint:'
\echo :source_constraint
\echo 'Unique index exists:'
\echo :unique_check
\echo 'Required columns exist:'
\echo :columns_check
```

**If any checks fail**, execute this fix:

```sql
BEGIN;

-- If unique index missing: create it
CREATE UNIQUE INDEX IF NOT EXISTS data_bars_unique_idx
ON data_bars(canonical_symbol, timeframe, ts_utc);

-- If columns missing: add them
ALTER TABLE data_bars ADD COLUMN IF NOT EXISTS raw JSONB DEFAULT '{}'::JSONB;
ALTER TABLE data_bars ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE data_bars ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- If source constraint too restrictive: fix it
ALTER TABLE data_bars DROP CONSTRAINT IF EXISTS data_bars_source_check;
ALTER TABLE data_bars ADD CONSTRAINT data_bars_source_check 
  CHECK (source IN ('massive_api', 'ingest', 'synthetic'));

COMMIT;
```

---

## Phase 3: Create DXY 1m Function (15 mins)

**Create the new function that writes to `data_bars`:**

```sql
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
  IF p_from_utc >= p_to_utc THEN
    RAISE EXCEPTION 'Invalid range: from >= to';
  END IF;

  WITH base_timestamps AS (
    SELECT DISTINCT ts_utc
    FROM data_bars
    WHERE timeframe = '1m'
      AND ts_utc >= p_from_utc
      AND ts_utc < p_to_utc
      AND canonical_symbol IN ('EURUSD','USDJPY','GBPUSD','USDCAD','USDSEK','USDCHF')
  ),

  fx_prices AS (
    SELECT 
      b.ts_utc,
      MAX(d.close) FILTER (WHERE d.canonical_symbol='EURUSD') eurusd,
      MAX(d.close) FILTER (WHERE d.canonical_symbol='USDJPY') usdjpy,
      MAX(d.close) FILTER (WHERE d.canonical_symbol='GBPUSD') gbpusd,
      MAX(d.close) FILTER (WHERE d.canonical_symbol='USDCAD') usdcad,
      MAX(d.close) FILTER (WHERE d.canonical_symbol='USDSEK') usdsek,
      MAX(d.close) FILTER (WHERE d.canonical_symbol='USDCHF') usdchf
    FROM base_timestamps b
    JOIN data_bars d ON d.ts_utc = b.ts_utc AND d.timeframe='1m'
      AND d.canonical_symbol IN ('EURUSD','USDJPY','GBPUSD','USDCAD','USDSEK','USDCHF')
    GROUP BY b.ts_utc
  ),

  valid_tuples AS (
    SELECT *
    FROM fx_prices
    WHERE eurusd>0 AND eurusd IS NOT NULL
      AND usdjpy>0 AND usdjpy IS NOT NULL
      AND gbpusd>0 AND gbpusd IS NOT NULL
      AND usdcad>0 AND usdcad IS NOT NULL
      AND usdsek>0 AND usdsek IS NOT NULL
      AND usdchf>0 AND usdchf IS NOT NULL
  ),

  dxy_bars AS (
    SELECT 
      ts_utc,
      (
        50.14348112
        * exp(-0.576*ln(eurusd))
        * exp(0.136*ln(usdjpy))
        * exp(-0.119*ln(gbpusd))
        * exp(0.091*ln(usdcad))
        * exp(0.042*ln(usdsek))
        * exp(0.036*ln(usdchf))
      )::DECIMAL(20,8) dxy_price
    FROM valid_tuples
  ),

  upserted AS (
    INSERT INTO data_bars (
      canonical_symbol, timeframe, ts_utc, open, high, low, close,
      vol, vwap, trade_count, is_partial, source, ingested_at, raw,
      created_at, updated_at
    )
    SELECT 
      'DXY', '1m', ts_utc, dxy_price, dxy_price, dxy_price, dxy_price,
      0, NULL, 0, false, 'synthetic', NOW(),
      jsonb_build_object('kind','dxy', 'version',p_derivation_version),
      NOW(), NOW()
    FROM dxy_bars
    ON CONFLICT (canonical_symbol, timeframe, ts_utc)
    DO UPDATE SET
      open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
      close=EXCLUDED.close, source='synthetic', updated_at=NOW()
    RETURNING (xmax=0) is_insert
  )

  SELECT 
    COUNT(*) FILTER (WHERE is_insert),
    COUNT(*) FILTER (WHERE NOT is_insert)
  INTO v_inserted, v_updated FROM upserted;

  WITH all_ts AS (SELECT ts_utc FROM base_timestamps),
       valid_ts AS (SELECT ts_utc FROM valid_tuples)
  SELECT COUNT(*) INTO v_skipped 
  FROM (SELECT ts_utc FROM all_ts EXCEPT SELECT ts_utc FROM valid_ts) x;

  RETURN jsonb_build_object(
    'success', true,
    'inserted', COALESCE(v_inserted, 0),
    'updated', COALESCE(v_updated, 0),
    'skipped', COALESCE(v_skipped, 0),
    'version', p_derivation_version
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success',false, 'error',SQLERRM);
END;
$$;

-- Test it on a small recent window
SELECT calc_dxy_range_1m(
  NOW() AT TIME ZONE 'UTC' - INTERVAL '1 hour',
  NOW() AT TIME ZONE 'UTC',
  1
) as result;
-- Should show: {"success":true, "inserted":X, "updated":0, "skipped":Y}
```

---

## Phase 4: Migrate Historical Data (20 mins)

**Option B: Keep source intact for 24h safety**

```sql
BEGIN;

-- Copy historical DXY 1m from derived_data_bars → data_bars
INSERT INTO data_bars (
  canonical_symbol, timeframe, ts_utc, open, high, low, close,
  vol, vwap, trade_count, is_partial, source, ingested_at, raw,
  created_at, updated_at
)
SELECT 
  canonical_symbol, timeframe, ts_utc, open, high, low, close,
  vol, vwap, trade_count, is_partial, 'synthetic', ingested_at,
  jsonb_build_object('kind','dxy','migrated_from','derived_data_bars'),
  COALESCE(created_at, ingested_at),
  NOW()
FROM derived_data_bars
WHERE canonical_symbol = 'DXY' 
  AND timeframe = '1m'
  AND deleted_at IS NULL
ON CONFLICT (canonical_symbol, timeframe, ts_utc)
DO UPDATE SET source='synthetic', updated_at=NOW();

\echo '✓ Migrated historical DXY 1m'

-- Verify
DO $$
DECLARE
  v_source_count INT;
  v_target_count INT;
BEGIN
  SELECT COUNT(*) INTO v_source_count
  FROM derived_data_bars
  WHERE canonical_symbol='DXY' AND timeframe='1m' AND deleted_at IS NULL;
  
  SELECT COUNT(*) INTO v_target_count
  FROM data_bars
  WHERE canonical_symbol='DXY' AND timeframe='1m';
  
  IF v_source_count != v_target_count THEN
    RAISE EXCEPTION 'Mismatch: source=%, target=%', v_source_count, v_target_count;
  END IF;
  
  RAISE NOTICE 'Migration verified: % bars in both locations', v_target_count;
END $$;

-- DO NOT DELETE YET — keep derived_data_bars rows for 24h safety (Option B)

COMMIT;
```

---

## Phase 5: Update Code (30 mins)

### 5.1 Tick Factory — Call New Function

**File**: `apps/python/shared/data_models/dxy_derivation.py` (or similar)

```python
def derive_dxy_for_window(from_ts: datetime, to_ts: datetime) -> dict:
    """
    Derive DXY 1m bars and write to data_bars.
    New location: data_bars (was: derived_data_bars)
    """
    result = supabase.rpc(
        'calc_dxy_range_1m',  # CHANGED from calc_dxy_range_derived
        {
            'p_from_utc': from_ts.isoformat(),
            'p_to_utc': to_ts.isoformat(),
            'p_derivation_version': 1
        }
    ).execute()
    
    if not result.data.get('success', False):
        raise Exception(f"DXY derivation failed: {result.data.get('error')}")
    
    return result.data
```

### 5.2 Aggregator — Single Table for 1m

**File**: `apps/python/aggregator/aggregate.py` (or your 1m query method)

```python
def get_source_bars_1m(symbol: str, from_ts: datetime, to_ts: datetime) -> List[dict]:
    """
    Get 1m bars for aggregation.
    After migration: All 1m bars (including DXY) are in data_bars.
    REMOVED: UNION ALL for derived_data_bars.
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
    
    return execute_query(query, (symbol, from_ts, to_ts))
```

### 5.3 Update Asset Registry

```sql
INSERT INTO core_asset_registry_all (
  canonical_symbol, asset_class, description, active, test_active,
  metadata, created_at, updated_at
) VALUES (
  'DXY', 'currency_index', 
  'US Dollar Index - 6 FX components',
  true, true,
  jsonb_build_object(
    'is_synthetic', true,
    'base_timeframe', '1m',
    'components', jsonb_build_array('EURUSD','USDJPY','GBPUSD','USDCAD','USDSEK','USDCHF'),
    'derived_timeframes', jsonb_build_array('5m', '1h')
  ),
  NOW(), NOW()
)
ON CONFLICT (canonical_symbol)
DO UPDATE SET metadata=EXCLUDED.metadata, updated_at=NOW();
```

---

## Phase 6: Test Minimal (20 mins)

**Run only these checks:**

```sql
-- 1. Verify new function produces rows
SELECT COUNT(*), 
       MIN(close) as min_price, 
       MAX(close) as max_price
FROM data_bars
WHERE canonical_symbol='DXY' AND timeframe='1m' AND ts_utc > NOW() - INTERVAL '1 hour';
-- Expected: count > 0, min >80, max <120

-- 2. Aggregation continues
SELECT COUNT(*)
FROM derived_data_bars
WHERE canonical_symbol='DXY' AND timeframe='5m' AND deleted_at IS NULL;
-- Expected: > 0

-- 3. Code compiles
# pytest tests/test_dxy.py -v
# Should pass or show no new failures
```

---

## Phase 7: Deploy to Production (30 mins)

```bash
#!/bin/bash
set -e

echo "=== DXY Migration Deployment ==="

# 1. Schema changes (idempotent, safe)
psql $DATABASE_URL -f db/migrations/dxy_schema_updates.sql

# 2. New function (idempotent)
psql $DATABASE_URL -f db/migrations/dxy_function_1m.sql

# 3. Historical data copy
psql $DATABASE_URL -f db/migrations/dxy_data_migration.sql

# 4. Deploy code (tick-factory, aggregator)
git commit -m "DXY: Migrate 1m from derived to data_bars (Option B, dual-write 24h)"
git push origin main
# Your deployment command here

# 5. Restart workers
pm2 restart tick-factory aggregator

# 6. Verify (first 10 minutes)
for i in {1..2}; do
  sleep 300  # Every 5 minutes
  psql $DATABASE_URL -c "
    SELECT 'DXY 1m latest' as check, MAX(ts_utc), COUNT(*)
    FROM data_bars WHERE canonical_symbol='DXY' AND timeframe='1m';
  "
done

echo "✓ Deployment complete. Monitor for 24h before cleanup."
```

---

## Phase 8: Post-Deploy Monitoring (24 hours)

**Run this query every hour for first 24h:**

```sql
SELECT 
  'DXY 1m freshness' as metric,
  NOW() AT TIME ZONE 'UTC' - MAX(ts_utc) as staleness,
  COUNT(*) as bars_in_last_hour,
  CASE 
    WHEN NOW() - MAX(ts_utc) < INTERVAL '5 minutes' THEN 'PASS'
    WHEN NOW() - MAX(ts_utc) < INTERVAL '10 minutes' THEN 'WARN'
    ELSE 'FAIL'
  END as status

UNION ALL

SELECT 
  'DXY 5m aggregation',
  NOW() - MAX(ts_utc),
  COUNT(*),
  CASE 
    WHEN NOW() - MAX(ts_utc) < INTERVAL '10 minutes' THEN 'PASS'
    ELSE 'WARN'
  END
FROM derived_data_bars
WHERE canonical_symbol='DXY' AND timeframe='5m' AND deleted_at IS NULL;
```

---

## Phase 9: Cleanup After 24h (10 mins)

**Only after full 24h verification passes:**

```sql
BEGIN;

-- Soft-delete old DXY 1m from derived_data_bars
UPDATE derived_data_bars
SET deleted_at = NOW(), updated_at = NOW()
WHERE canonical_symbol = 'DXY' 
  AND timeframe = '1m'
  AND deleted_at IS NULL;

\echo '✓ Soft-deleted legacy DXY 1m'

-- Verify no orphans remain active
SELECT COUNT(*)
FROM derived_data_bars
WHERE canonical_symbol='DXY' AND timeframe='1m' AND deleted_at IS NULL;
-- Expected: 0

COMMIT;
```

---

## Rollback (Emergency Only)

**If critical issue in first 24h:**

```sql
BEGIN;

-- Revert Tick Factory code to call old RPC (manually)
-- Revert Aggregator code to use UNION ALL (manually)

-- Existing old data still in derived_data_bars (un-deleted)
UPDATE derived_data_bars
SET deleted_at = NULL, updated_at = NOW()
WHERE canonical_symbol='DXY' AND timeframe='1m' AND deleted_at IS NOT NULL
  AND created_at < NOW() - INTERVAL '24 hours';

-- Keep new DXY 1m in data_bars (harmless, just ignored)
-- OR delete if you want total state revert:
-- DELETE FROM data_bars WHERE canonical_symbol='DXY' AND timeframe='1m' AND source='synthetic';

COMMIT;
```

---

## Success Criteria (Must All Pass)

- ✅ DXY 1m bars present in `data_bars` with `source='synthetic'`
- ✅ New bars created every 1m in `data_bars`
- ✅ DXY 5m/1h bars still produced on schedule
- ✅ Aggregator queries work (no UNION ALL)
- ✅ No errors in tick-factory/aggregator logs for 24h
- ✅ Price freshness < 5 minutes
- ✅ No price outliers (80-120 range normal)

---

## Timeline

| Phase | Task | Duration | Day |
|-------|------|----------|-----|
| 1 | Pre-checks, backup | 15 min | 1 |
| 2 | Schema validation | 10 min | 1 |
| 3 | Create function | 15 min | 1 |
| 4 | Copy historical data | 20 min | 1 |
| 5 | Code updates | 30 min | 2 |
| 6 | Testing | 20 min | 2 |
| 7 | Deploy | 30 min | 2 |
| 8 | Monitor | 24 hr | 2-3 |
| 9 | Cleanup | 10 min | 3 |
| **Total** | | **3-4 hrs** | |

---

## Sign-Off

- **Prepared by**: Amit & critical review feedback
- **Status**: Locked & ready to execute line-by-line
- **Approval**: [Pending]
