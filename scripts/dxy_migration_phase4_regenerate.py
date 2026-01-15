#!/usr/bin/env python3
"""
DXY Migration - Phase 4 (REVISED): Regenerate Historical Data
--------------------------------------------------------------
Instead of copying from derived_data_bars, regenerates ALL DXY 1m bars
from scratch using the new calc_dxy_range_1m function.

Starting date: 2025-12-31 00:00:00 UTC
Ending date: Current time

This ensures clean, properly calculated DXY data using the new function.
"""

import os
import sys
import json
from datetime import datetime, timezone
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

def check_fx_data_availability(conn):
    """Check available FX component data"""
    print("\n📋 Step 4.1: Check FX Component Data Availability")
    print("-" * 60)
    
    with conn.cursor() as cur:
        cur.execute("""
            SELECT 
                canonical_symbol,
                COUNT(*) as bar_count,
                MIN(ts_utc) as earliest,
                MAX(ts_utc) as latest
            FROM data_bars
            WHERE canonical_symbol IN ('EURUSD','USDJPY','GBPUSD','USDCAD','USDSEK','USDCHF')
              AND timeframe = '1m'
              AND ts_utc >= '2025-12-31 00:00:00+00'::timestamptz
            GROUP BY canonical_symbol
            ORDER BY canonical_symbol
        """)
        fx_data = cur.fetchall()
        
        if not fx_data:
            print("❌ No FX component data found from 2025-12-31!")
            return None
        
        print("FX Component Data:")
        min_earliest = None
        max_latest = None
        min_count = float('inf')
        
        for row in fx_data:
            print(f"  {row['canonical_symbol']}: {row['bar_count']} bars")
            print(f"    Range: {row['earliest']} to {row['latest']}")
            
            if min_earliest is None or row['earliest'] < min_earliest:
                min_earliest = row['earliest']
            if max_latest is None or row['latest'] > max_latest:
                max_latest = row['latest']
            if row['bar_count'] < min_count:
                min_count = row['bar_count']
        
        print(f"\n📊 Overall FX data range: {min_earliest} to {max_latest}")
        print(f"   Minimum bar count across all pairs: {min_count}")
        
        return {
            'earliest': min_earliest,
            'latest': max_latest,
            'min_count': min_count,
            'pairs': len(fx_data)
        }

def clear_existing_dxy_data(conn):
    """Clear any existing DXY 1m data from data_bars"""
    print("\n📋 Step 4.2: Clear Existing DXY Data")
    print("-" * 60)
    
    with conn.cursor() as cur:
        # Check existing
        cur.execute("""
            SELECT COUNT(*) as count
            FROM data_bars
            WHERE canonical_symbol = 'DXY'
              AND timeframe = '1m'
        """)
        existing = cur.fetchone()['count']
        
        if existing > 0:
            print(f"Found {existing} existing DXY 1m bars in data_bars")
            print("Deleting to ensure clean regeneration...")
            
            cur.execute("""
                DELETE FROM data_bars
                WHERE canonical_symbol = 'DXY'
                  AND timeframe = '1m'
            """)
            deleted = cur.rowcount
            conn.commit()
            print(f"✅ Deleted {deleted} existing bars")
        else:
            print("✅ No existing DXY data (clean state)")
        
        return existing

def regenerate_dxy_data(conn, start_date, end_date):
    """Regenerate DXY data using calc_dxy_range_1m function"""
    print("\n📋 Step 4.3: Regenerate DXY Data Using calc_dxy_range_1m")
    print("-" * 60)
    print(f"Time range: {start_date} to {end_date}")
    print("(This may take 30-60 seconds for 2 weeks of data...)")
    
    try:
        with conn.cursor() as cur:
            # Call the function to regenerate all data
            cur.execute("""
                SELECT calc_dxy_range_1m(
                    %s::timestamptz,
                    %s::timestamptz,
                    1
                ) as result
            """, (start_date, end_date))
            
            result = cur.fetchone()['result']
            
            print(f"\nRegeneration result:")
            print(f"  Success: {result.get('success')}")
            print(f"  Inserted: {result.get('inserted', 0)}")
            print(f"  Updated: {result.get('updated', 0)}")
            print(f"  Skipped: {result.get('skipped', 0)}")
            
            if result.get('error'):
                print(f"  Error: {result.get('error')}")
                return None
            
            if not result.get('success'):
                print("❌ Function returned success=false")
                return None
            
            print(f"\n✅ Successfully regenerated {result.get('inserted', 0)} DXY bars")
            return result
            
    except psycopg2.Error as e:
        print(f"❌ Regeneration failed: {e}")
        conn.rollback()
        return None

def verify_regenerated_data(conn):
    """Verify the regenerated data"""
    print("\n📋 Step 4.4: Verify Regenerated Data")
    print("-" * 60)
    
    with conn.cursor() as cur:
        # Count new data
        cur.execute("""
            SELECT 
                COUNT(*) as total_count,
                MIN(ts_utc) as earliest,
                MAX(ts_utc) as latest,
                AVG(close) as avg_close,
                MIN(close) as min_close,
                MAX(close) as max_close
            FROM data_bars
            WHERE canonical_symbol = 'DXY'
              AND timeframe = '1m'
              AND source = 'synthetic'
        """)
        dxy_info = cur.fetchone()
        
        print(f"Regenerated DXY 1m data:")
        print(f"  Total bars: {dxy_info['total_count']}")
        print(f"  Date range: {dxy_info['earliest']} to {dxy_info['latest']}")
        print(f"  DXY values: {float(dxy_info['min_close']):.2f} to {float(dxy_info['max_close']):.2f}")
        print(f"  Average: {float(dxy_info['avg_close']):.2f}")
        
        # Sample recent data
        cur.execute("""
            SELECT ts_utc, close, source
            FROM data_bars
            WHERE canonical_symbol = 'DXY'
              AND timeframe = '1m'
            ORDER BY ts_utc DESC
            LIMIT 5
        """)
        samples = cur.fetchall()
        
        print(f"\nSample recent bars:")
        for row in samples:
            print(f"  {row['ts_utc']} | Close: {float(row['close']):.4f} | Source: {row['source']}")
        
        # Compare with old data in derived_data_bars
        cur.execute("""
            SELECT COUNT(*) as count
            FROM derived_data_bars
            WHERE canonical_symbol = 'DXY'
              AND timeframe = '1m'
        """)
        old_count = cur.fetchone()['count']
        
        print(f"\nComparison with old data:")
        print(f"  Old (derived_data_bars): {old_count} bars")
        print(f"  New (data_bars): {dxy_info['total_count']} bars")
        
        if dxy_info['total_count'] > 0:
            diff = dxy_info['total_count'] - old_count
            if diff > 0:
                print(f"  ✅ New data has {diff} MORE bars (recalculated from FX components)")
            elif diff < 0:
                print(f"  ⚠️  New data has {abs(diff)} FEWER bars (may be due to missing FX data)")
            else:
                print(f"  ✅ Same count (data regenerated successfully)")
        
        return dxy_info

def save_phase4_state(conn, output_dir, regeneration_info):
    """Save post-regeneration state"""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT 
                canonical_symbol,
                COUNT(*) as bar_count,
                MIN(ts_utc)::text as earliest,
                MAX(ts_utc)::text as latest
            FROM data_bars
            WHERE canonical_symbol = 'DXY' AND timeframe = '1m'
            GROUP BY canonical_symbol
        """)
        dxy_summary = [dict(row) for row in cur.fetchall()]
    
    state = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "regeneration_method": "calc_dxy_range_1m",
        "regeneration_info": regeneration_info,
        "dxy_summary": dxy_summary
    }
    
    output_file = output_dir / "post_phase4_regeneration_state.json"
    with open(output_file, 'w') as f:
        json.dump(state, f, indent=2)
    
    print(f"\n✅ Post-Phase-4 state saved to: {output_file}")

def main():
    print("=" * 60)
    print("DXY MIGRATION - PHASE 4 (REVISED): REGENERATE DXY DATA")
    print("=" * 60)
    
    # Create output directory
    output_dir = Path("artifacts/dxy_migration")
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Define time range
    start_date = '2025-12-31 00:00:00+00'
    
    try:
        conn = get_conn()
        print("✅ Database connection successful")
        
        # Step 4.1: Check FX data availability
        fx_info = check_fx_data_availability(conn)
        if not fx_info:
            print("\n❌ PHASE 4 FAILED: No FX component data available")
            return 1
        
        if fx_info['pairs'] < 6:
            print(f"\n⚠️  WARNING: Only {fx_info['pairs']}/6 FX pairs available")
            print("   DXY calculation requires all 6 pairs")
        
        # Use actual data range
        end_date = fx_info['latest']
        
        # Step 4.2: Clear existing DXY data
        clear_existing_dxy_data(conn)
        
        # Step 4.3: Regenerate DXY data
        regen_result = regenerate_dxy_data(conn, start_date, end_date)
        if not regen_result:
            print("\n❌ PHASE 4 FAILED: Regeneration failed")
            return 1
        
        # Step 4.4: Verify regenerated data
        dxy_info = verify_regenerated_data(conn)
        if dxy_info['total_count'] == 0:
            print("\n❌ PHASE 4 FAILED: No data was regenerated")
            return 1
        
        # Save state
        regeneration_info = {
            "start_date": start_date,
            "end_date": str(end_date),
            "bars_inserted": regen_result.get('inserted', 0),
            "bars_updated": regen_result.get('updated', 0),
            "bars_skipped": regen_result.get('skipped', 0),
            "total_in_data_bars": dxy_info['total_count']
        }
        save_phase4_state(conn, output_dir, regeneration_info)
        
        print("\n" + "=" * 60)
        print("✅ PHASE 4 COMPLETE: DXY Data Regenerated from Scratch")
        print("=" * 60)
        print(f"\nRegeneration Summary:")
        print(f"  {regen_result.get('inserted', 0)} DXY bars calculated and inserted")
        print(f"  {dxy_info['total_count']} total DXY 1m bars now in data_bars")
        print(f"  Date range: {dxy_info['earliest']} to {dxy_info['latest']}")
        print(f"  Old data preserved in derived_data_bars for reference")
        print("\nNext step: Phase 5 (Update code to read from data_bars)")
        
        conn.close()
        return 0
        
    except Exception as e:
        print(f"\n❌ PHASE 4 FAILED: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == "__main__":
    sys.exit(main())
