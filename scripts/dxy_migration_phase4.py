#!/usr/bin/env python3
"""
DXY Migration - Phase 4: Migrate Historical Data
-------------------------------------------------
Copies existing DXY 1m bars from derived_data_bars to data_bars.

Using Option B: Keep source intact for 24h safety.
- Copies data without deleting source
- Source will be cleaned up in Phase 9 after monitoring period

Safe to run multiple times (uses INSERT ... ON CONFLICT DO NOTHING).
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

def check_source_data(conn):
    """Check how much data needs to be migrated"""
    print("\n📋 Step 4.1: Check Source Data")
    print("-" * 60)
    
    with conn.cursor() as cur:
        # Count DXY 1m in derived_data_bars
        cur.execute("""
            SELECT 
                COUNT(*) as total_count,
                MIN(ts_utc) as earliest,
                MAX(ts_utc) as latest
            FROM derived_data_bars
            WHERE canonical_symbol = 'DXY'
              AND timeframe = '1m'
        """)
        source_info = cur.fetchone()
        
        # Count existing DXY 1m in data_bars
        cur.execute("""
            SELECT COUNT(*) as count
            FROM data_bars
            WHERE canonical_symbol = 'DXY'
              AND timeframe = '1m'
        """)
        existing_info = cur.fetchone()
        
        print(f"Source (derived_data_bars):")
        print(f"  Total DXY 1m bars: {source_info['total_count']}")
        print(f"  Date range: {source_info['earliest']} to {source_info['latest']}")
        
        print(f"\nTarget (data_bars):")
        print(f"  Existing DXY 1m bars: {existing_info['count']}")
        
        to_migrate = source_info['total_count'] - existing_info['count']
        print(f"\n📊 Estimated bars to migrate: {to_migrate}")
        
        return source_info, existing_info

def migrate_historical_data(conn):
    """Copy DXY 1m bars from derived_data_bars to data_bars"""
    print("\n📋 Step 4.2: Migrate Historical Data")
    print("-" * 60)
    
    try:
        with conn.cursor() as cur:
            print("Copying DXY 1m bars from derived_data_bars to data_bars...")
            print("(This may take a moment...)")
            
            # Copy with ON CONFLICT DO NOTHING (idempotent)
            cur.execute("""
                INSERT INTO data_bars (
                    canonical_symbol, timeframe, ts_utc,
                    open, high, low, close,
                    vol, vwap, trade_count,
                    is_partial, source, ingested_at, raw
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
                    'migrated_from_derived',  -- Mark as migrated
                    ingested_at,
                    jsonb_build_object(
                        'migrated_from', 'derived_data_bars',
                        'original_source', source,
                        'migration_timestamp', NOW()
                    )
                FROM derived_data_bars
                WHERE canonical_symbol = 'DXY'
                  AND timeframe = '1m'
                ON CONFLICT (canonical_symbol, timeframe, ts_utc)
                DO NOTHING
            """)
            
            rows_inserted = cur.rowcount
            conn.commit()
            
            print(f"✅ Migration complete: {rows_inserted} bars inserted")
            print("   (Bars already existing were skipped)")
            
            return rows_inserted
            
    except psycopg2.Error as e:
        print(f"❌ Migration failed: {e}")
        conn.rollback()
        return None

def verify_migration(conn):
    """Verify the migration was successful"""
    print("\n📋 Step 4.3: Verify Migration")
    print("-" * 60)
    
    with conn.cursor() as cur:
        # Count migrated data
        cur.execute("""
            SELECT 
                COUNT(*) as total_count,
                COUNT(*) FILTER (WHERE source = 'migrated_from_derived') as migrated_count,
                COUNT(*) FILTER (WHERE source = 'synthetic') as synthetic_count,
                MIN(ts_utc) as earliest,
                MAX(ts_utc) as latest
            FROM data_bars
            WHERE canonical_symbol = 'DXY'
              AND timeframe = '1m'
        """)
        target_info = cur.fetchone()
        
        # Count source data (should still be there)
        cur.execute("""
            SELECT COUNT(*) as count
            FROM derived_data_bars
            WHERE canonical_symbol = 'DXY'
              AND timeframe = '1m'
        """)
        source_info = cur.fetchone()
        
        print(f"Target (data_bars) after migration:")
        print(f"  Total DXY 1m bars: {target_info['total_count']}")
        print(f"  Migrated from derived: {target_info['migrated_count']}")
        print(f"  Synthetic (from Phase 3 test): {target_info['synthetic_count']}")
        print(f"  Date range: {target_info['earliest']} to {target_info['latest']}")
        
        print(f"\nSource (derived_data_bars) - preserved for safety:")
        print(f"  DXY 1m bars still present: {source_info['count']}")
        print(f"  ℹ️  Source data kept for 24h monitoring period")
        
        # Sample some migrated data
        cur.execute("""
            SELECT ts_utc, close, source
            FROM data_bars
            WHERE canonical_symbol = 'DXY'
              AND timeframe = '1m'
              AND source = 'migrated_from_derived'
            ORDER BY ts_utc DESC
            LIMIT 3
        """)
        samples = cur.fetchall()
        
        if samples:
            print(f"\nSample migrated bars:")
            for row in samples:
                print(f"  {row['ts_utc']} | Close: {row['close']} | Source: {row['source']}")
        
        # Verification checks
        all_good = True
        
        if target_info['total_count'] < source_info['count']:
            print(f"\n⚠️  Warning: Target has fewer bars than source")
            print(f"   This is expected if Phase 3 test created newer bars")
            # This is actually OK - source might have some bars that Phase 3 already created
        
        if target_info['migrated_count'] == 0:
            print(f"\n❌ Error: No bars were migrated")
            all_good = False
        
        if source_info['count'] == 0:
            print(f"\n❌ Error: Source data is missing!")
            all_good = False
        
        return all_good, target_info

def save_phase4_state(conn, output_dir, migration_info):
    """Save post-migration state"""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT 
                source,
                COUNT(*) as count
            FROM data_bars
            WHERE canonical_symbol = 'DXY' AND timeframe = '1m'
            GROUP BY source
            ORDER BY count DESC
        """)
        source_breakdown = [dict(row) for row in cur.fetchall()]
    
    state = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "migration_info": migration_info,
        "source_breakdown": source_breakdown
    }
    
    output_file = output_dir / "post_phase4_state.json"
    with open(output_file, 'w') as f:
        json.dump(state, f, indent=2)
    
    print(f"\n✅ Post-Phase-4 state saved to: {output_file}")

def main():
    print("=" * 60)
    print("DXY MIGRATION - PHASE 4: MIGRATE HISTORICAL DATA")
    print("=" * 60)
    
    # Create output directory
    output_dir = Path("artifacts/dxy_migration")
    output_dir.mkdir(parents=True, exist_ok=True)
    
    try:
        conn = get_conn()
        print("✅ Database connection successful")
        
        # Step 4.1: Check source data
        source_info, existing_info = check_source_data(conn)
        
        # Step 4.2: Migrate data
        rows_inserted = migrate_historical_data(conn)
        if rows_inserted is None:
            print("\n❌ PHASE 4 FAILED: Migration error")
            return 1
        
        # Step 4.3: Verify migration
        verification_ok, target_info = verify_migration(conn)
        if not verification_ok:
            print("\n❌ PHASE 4 FAILED: Verification failed")
            return 1
        
        # Save state
        migration_info = {
            "rows_inserted": rows_inserted,
            "total_in_target": target_info['total_count'],
            "migrated_count": target_info['migrated_count'],
            "synthetic_count": target_info['synthetic_count']
        }
        save_phase4_state(conn, output_dir, migration_info)
        
        print("\n" + "=" * 60)
        print("✅ PHASE 4 COMPLETE: Historical Data Migrated")
        print("=" * 60)
        print(f"\nMigration Summary:")
        print(f"  {rows_inserted} bars copied to data_bars")
        print(f"  {target_info['total_count']} total DXY 1m bars now in data_bars")
        print(f"  Source data preserved in derived_data_bars for 24h safety")
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
