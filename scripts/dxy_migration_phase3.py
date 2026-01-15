#!/usr/bin/env python3
"""
DXY Migration - Phase 3: Create calc_dxy_range_1m Function
-----------------------------------------------------------
Creates a new PostgreSQL function to calculate DXY 1m bars from FX components
and insert them into data_bars table (instead of derived_data_bars).

This function will be used going forward for real-time DXY generation.

Safe to run multiple times (idempotent - uses CREATE OR REPLACE).
"""

import os
import sys
from pathlib import Path

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
    from dotenv import load_dotenv
except ImportError as e:
    print(f"❌ Missing dependency: {e}")
    print("Install with: pip install psycopg2-binary python-dotenv")
    sys.exit(1)

# Load environment variables
load_dotenv()

def get_conn():
    """Get database connection using same pattern as verify_data.py"""
    dsn = os.getenv("PG_DSN")
    if dsn:
        return psycopg2.connect(dsn, cursor_factory=RealDictCursor)
    
    host = os.getenv("PGHOST")
    user = os.getenv("PGUSER")
    pwd = os.getenv("PGPASSWORD")
    db = os.getenv("PGDATABASE", "postgres")
    
    if not all([host, user, pwd]):
        raise ValueError("Missing required env vars: PGHOST, PGUSER, PGPASSWORD or PG_DSN")
    
    return psycopg2.connect(
        host=host,
        user=user,
        password=pwd,
        database=db,
        cursor_factory=RealDictCursor
    )

# Function SQL
CALC_DXY_RANGE_1M_FUNCTION = """
CREATE OR REPLACE FUNCTION calc_dxy_range_1m(
  p_from_utc TIMESTAMPTZ,
  p_to_utc TIMESTAMPTZ,
  p_derivation_version INT DEFAULT 1
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted INT := 0;
  v_updated INT := 0;
  v_skipped INT := 0;
BEGIN
  -- Validate timestamps
  IF p_from_utc >= p_to_utc THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'p_from_utc must be before p_to_utc'
    );
  END IF;

  -- Generate DXY bars and upsert into data_bars
  WITH base_timestamps AS (
    SELECT DISTINCT ts_utc
    FROM data_bars
    WHERE canonical_symbol IN ('EURUSD','USDJPY','GBPUSD','USDCAD','USDSEK','USDCHF')
      AND timeframe = '1m'
      AND ts_utc >= p_from_utc
      AND ts_utc < p_to_utc
  ),

  fx_pivoted AS (
    SELECT 
      ts_utc,
      MAX(CASE WHEN canonical_symbol='EURUSD' THEN close END) AS eurusd,
      MAX(CASE WHEN canonical_symbol='USDJPY' THEN close END) AS usdjpy,
      MAX(CASE WHEN canonical_symbol='GBPUSD' THEN close END) AS gbpusd,
      MAX(CASE WHEN canonical_symbol='USDCAD' THEN close END) AS usdcad,
      MAX(CASE WHEN canonical_symbol='USDSEK' THEN close END) AS usdsek,
      MAX(CASE WHEN canonical_symbol='USDCHF' THEN close END) AS usdchf
    FROM data_bars
    WHERE canonical_symbol IN ('EURUSD','USDJPY','GBPUSD','USDCAD','USDSEK','USDCHF')
      AND timeframe = '1m'
      AND ts_utc >= p_from_utc
      AND ts_utc < p_to_utc
    GROUP BY ts_utc
  ),

  valid_tuples AS (
    SELECT *
    FROM fx_pivoted
    WHERE eurusd > 0 AND usdjpy > 0 AND gbpusd > 0
      AND usdcad > 0 AND usdsek > 0 AND usdchf > 0
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
      )::DECIMAL(20,8) AS dxy_price
    FROM valid_tuples
  ),

  upserted AS (
    INSERT INTO data_bars (
      canonical_symbol, timeframe, ts_utc, open, high, low, close,
      vol, vwap, trade_count, is_partial, source, ingested_at, raw
    )
    SELECT 
      'DXY', '1m', ts_utc, dxy_price, dxy_price, dxy_price, dxy_price,
      0, NULL, 0, false, 'synthetic', NOW(),
      jsonb_build_object('kind','dxy', 'version',p_derivation_version)
    FROM dxy_bars
    ON CONFLICT (canonical_symbol, timeframe, ts_utc)
    DO UPDATE SET
      open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
      close=EXCLUDED.close, source='synthetic', ingested_at=NOW()
    RETURNING (xmax=0) AS is_insert
  ),

  count_results AS (
    SELECT 
      COUNT(*) FILTER (WHERE is_insert) AS num_inserted,
      COUNT(*) FILTER (WHERE NOT is_insert) AS num_updated
    FROM upserted
  ),

  skip_count AS (
    SELECT COUNT(*) AS num_skipped
    FROM (
      SELECT ts_utc FROM base_timestamps
      EXCEPT
      SELECT ts_utc FROM valid_tuples
    ) x
  )

  SELECT num_inserted, num_updated, num_skipped
  INTO v_inserted, v_updated, v_skipped
  FROM count_results, skip_count;

  RETURN jsonb_build_object(
    'success', true,
    'inserted', COALESCE(v_inserted, 0),
    'updated', COALESCE(v_updated, 0),
    'skipped', COALESCE(v_skipped, 0),
    'version', p_derivation_version
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
"""

def create_function(conn):
    """Create or replace the calc_dxy_range_1m function"""
    print("\n📋 Step 3.1: Create calc_dxy_range_1m Function")
    print("-" * 60)
    
    try:
        with conn.cursor() as cur:
            print("Creating function calc_dxy_range_1m...")
            cur.execute(CALC_DXY_RANGE_1M_FUNCTION)
            conn.commit()
            print("✅ Function created successfully")
            return True
    except psycopg2.Error as e:
        print(f"❌ Failed to create function: {e}")
        conn.rollback()
        return False

def test_function(conn):
    """Test the function with a recent 1-hour window"""
    print("\n📋 Step 3.2: Test calc_dxy_range_1m Function")
    print("-" * 60)
    
    try:
        with conn.cursor() as cur:
            print("Testing function with last 1 hour of data...")
            cur.execute("""
                SELECT calc_dxy_range_1m(
                    NOW() AT TIME ZONE 'UTC' - INTERVAL '1 hour',
                    NOW() AT TIME ZONE 'UTC',
                    1
                ) as result
            """)
            result = cur.fetchone()['result']
            
            print(f"\nTest result:")
            print(f"  Success: {result.get('success')}")
            print(f"  Inserted: {result.get('inserted', 0)}")
            print(f"  Updated: {result.get('updated', 0)}")
            print(f"  Skipped: {result.get('skipped', 0)}")
            
            if result.get('error'):
                print(f"  Error: {result.get('error')}")
            
            if result.get('success'):
                print("\n✅ Function test passed")
                return True
            else:
                print("\n⚠️  Function returned success=false")
                return False
                
    except psycopg2.Error as e:
        print(f"❌ Function test failed: {e}")
        conn.rollback()
        return False

def verify_test_data(conn):
    """Verify that test data was inserted into data_bars"""
    print("\n📋 Step 3.3: Verify Test Data in data_bars")
    print("-" * 60)
    
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT COUNT(*) as count
                FROM data_bars
                WHERE canonical_symbol = 'DXY'
                  AND timeframe = '1m'
                  AND source = 'synthetic'
                  AND ts_utc >= NOW() AT TIME ZONE 'UTC' - INTERVAL '1 hour'
            """)
            result = cur.fetchone()
            count = result['count']
            
            print(f"DXY 1m bars in data_bars (last 1 hour): {count}")
            
            if count > 0:
                # Show a sample
                cur.execute("""
                    SELECT ts_utc, close, source
                    FROM data_bars
                    WHERE canonical_symbol = 'DXY'
                      AND timeframe = '1m'
                      AND ts_utc >= NOW() AT TIME ZONE 'UTC' - INTERVAL '1 hour'
                    ORDER BY ts_utc DESC
                    LIMIT 3
                """)
                samples = cur.fetchall()
                print("\nSample bars:")
                for row in samples:
                    print(f"  {row['ts_utc']} | Close: {row['close']} | Source: {row['source']}")
                
                print("\n✅ Test data verified in data_bars")
                return True
            else:
                print("⚠️  No test data found - may need more FX component data")
                return True  # Not a failure, just means no data available
                
    except psycopg2.Error as e:
        print(f"❌ Verification failed: {e}")
        return False

def main():
    print("=" * 60)
    print("DXY MIGRATION - PHASE 3: CREATE calc_dxy_range_1m FUNCTION")
    print("=" * 60)
    
    # Create output directory
    output_dir = Path("artifacts/dxy_migration")
    output_dir.mkdir(parents=True, exist_ok=True)
    
    try:
        conn = get_conn()
        print("✅ Database connection successful\n")
        
        # Step 3.1: Create function
        if not create_function(conn):
            print("\n❌ PHASE 3 FAILED: Could not create function")
            return 1
        
        # Step 3.2: Test function
        if not test_function(conn):
            print("\n❌ PHASE 3 FAILED: Function test failed")
            return 1
        
        # Step 3.3: Verify test data
        if not verify_test_data(conn):
            print("\n❌ PHASE 3 FAILED: Could not verify test data")
            return 1
        
        print("\n" + "=" * 60)
        print("✅ PHASE 3 COMPLETE: Function Ready for Migration")
        print("=" * 60)
        print("\nNext step: Phase 4 (Migrate historical data)")
        print("Note: Function is now available for real-time use")
        
        conn.close()
        return 0
        
    except Exception as e:
        print(f"\n❌ PHASE 3 FAILED: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == "__main__":
    sys.exit(main())
