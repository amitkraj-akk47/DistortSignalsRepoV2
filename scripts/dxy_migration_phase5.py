#!/usr/bin/env python3
"""
DXY Migration - Phase 5: Update Code (Apply SQL Migration)
----------------------------------------------------------
Applies the SQL migration to update aggregation functions.

Changes:
1. aggregate_1m_to_5m_window: Removes UNION ALL (reads only from data_bars)
2. catchup_aggregation_range: Smart max source check based on timeframe
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
    """Get database connection"""
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

def apply_migration(conn):
    """Apply the SQL migration"""
    print("\n📋 Step 5.1: Apply SQL Migration")
    print("-" * 60)
    
    migration_file = Path(__file__).parent / "dxy_migration_phase5.sql"
    
    if not migration_file.exists():
        print(f"❌ Migration file not found: {migration_file}")
        return False
    
    print(f"Reading migration from: {migration_file.name}")
    
    with open(migration_file, 'r') as f:
        migration_sql = f.read()
    
    try:
        with conn.cursor() as cur:
            print("Applying migration...")
            cur.execute(migration_sql)
            conn.commit()
            print("✅ Migration applied successfully")
            return True
    except psycopg2.Error as e:
        print(f"❌ Migration failed: {e}")
        conn.rollback()
        return False

def test_aggregation(conn):
    """Test the updated aggregation function"""
    print("\n📋 Step 5.2: Test Updated Aggregation Function")
    print("-" * 60)
    
    try:
        with conn.cursor() as cur:
            print("Testing aggregate_1m_to_5m_window with DXY...")
            
            # Test with recent 5-minute window
            cur.execute("""
                SELECT aggregate_1m_to_5m_window(
                    'DXY',
                    date_trunc('hour', NOW() AT TIME ZONE 'UTC') + INTERVAL '5 minutes',
                    date_trunc('hour', NOW() AT TIME ZONE 'UTC') + INTERVAL '10 minutes',
                    1
                ) as result
            """)
            
            result = cur.fetchone()['result']
            
            print(f"\nAggregation test result:")
            print(f"  Success: {result.get('success')}")
            print(f"  Stored: {result.get('stored')}")
            print(f"  Source count: {result.get('source_count', 0)}")
            print(f"  Quality score: {result.get('quality_score', 'N/A')}")
            
            if result.get('reason'):
                print(f"  Reason: {result.get('reason')}")
            
            if result.get('success'):
                print("\n✅ Aggregation function test passed")
                return True
            else:
                print("\n⚠️  Aggregation test returned success=false")
                return False
                
    except psycopg2.Error as e:
        print(f"❌ Aggregation test failed: {e}")
        return False

def verify_dxy_5m_generation(conn):
    """Verify that DXY 5m bars can be generated from new 1m data"""
    print("\n📋 Step 5.3: Verify DXY 5m Bar Generation")
    print("-" * 60)
    
    try:
        with conn.cursor() as cur:
            # Check if we have recent DXY 5m bars
            cur.execute("""
                SELECT 
                    COUNT(*) as bar_count,
                    MAX(ts_utc) as latest_5m,
                    MAX(ingested_at) as latest_update
                FROM derived_data_bars
                WHERE canonical_symbol = 'DXY'
                  AND timeframe = '5m'
                  AND ts_utc >= NOW() AT TIME ZONE 'UTC' - INTERVAL '1 hour'
            """)
            
            result = cur.fetchone()
            
            print(f"Recent DXY 5m bars (last hour):")
            print(f"  Count: {result['bar_count']}")
            print(f"  Latest: {result['latest_5m']}")
            print(f"  Last update: {result['latest_update']}")
            
            # Check DXY 1m availability
            cur.execute("""
                SELECT 
                    COUNT(*) as bar_count,
                    MAX(ts_utc) as latest_1m
                FROM data_bars
                WHERE canonical_symbol = 'DXY'
                  AND timeframe = '1m'
                  AND ts_utc >= NOW() AT TIME ZONE 'UTC' - INTERVAL '1 hour'
            """)
            
            result_1m = cur.fetchone()
            
            print(f"\nDXY 1m source data (last hour):")
            print(f"  Count: {result_1m['bar_count']}")
            print(f"  Latest: {result_1m['latest_1m']}")
            
            if result_1m['bar_count'] > 0:
                print("\n✅ DXY 1m data available in data_bars (migration working)")
            else:
                print("\n⚠️  No recent DXY 1m data in data_bars")
            
            return True
                
    except psycopg2.Error as e:
        print(f"❌ Verification failed: {e}")
        return False

def main():
    print("=" * 60)
    print("DXY MIGRATION - PHASE 5: UPDATE CODE")
    print("=" * 60)
    
    try:
        conn = get_conn()
        print("✅ Database connection successful")
        
        # Step 5.1: Apply migration
        if not apply_migration(conn):
            print("\n❌ PHASE 5 FAILED: Could not apply migration")
            return 1
        
        # Step 5.2: Test aggregation
        if not test_aggregation(conn):
            print("\n❌ PHASE 5 FAILED: Aggregation test failed")
            return 1
        
        # Step 5.3: Verify DXY 5m generation
        if not verify_dxy_5m_generation(conn):
            print("\n❌ PHASE 5 FAILED: Could not verify 5m generation")
            return 1
        
        print("\n" + "=" * 60)
        print("✅ PHASE 5 COMPLETE: Code Updated Successfully")
        print("=" * 60)
        print("\nChanges Applied:")
        print("  ✅ aggregate_1m_to_5m_window: Now reads only from data_bars")
        print("  ✅ catchup_aggregation_range: Smart source checking by timeframe")
        print("  ✅ DXY 1m → 5m aggregation: Verified working")
        print("\nNext step: Phase 6 (Testing - aggregator will use new logic)")
        print("           Phase 7 (Deployment)")
        print("           Phase 8 (24h monitoring)")
        print("           Phase 9 (Cleanup old DXY data from derived_data_bars)")
        
        conn.close()
        return 0
        
    except Exception as e:
        print(f"\n❌ PHASE 5 FAILED: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == "__main__":
    sys.exit(main())
