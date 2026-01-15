#!/usr/bin/env python3
"""
DXY Migration - Phase 1: Pre-Migration Safety Checks

Verifies database connectivity and captures pre-migration state.

Usage:
  python scripts/dxy_migration_phase1.py
"""

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
    from dotenv import load_dotenv
except ImportError as e:
    print(f"ERROR: Missing required dependency: {e}")
    print("Please run: pip install psycopg2-binary python-dotenv")
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
    port = int(os.getenv("PGPORT", "5432"))
    sslmode = os.getenv("PGSSLMODE", "require")

    missing = [k for k, v in [("PGHOST", host), ("PGUSER", user), ("PGPASSWORD", pwd)] if not v]
    if missing:
        raise RuntimeError(
            f"Missing DB env vars: {', '.join(missing)}. "
            f"Set PG_DSN or PGHOST/PGUSER/PGPASSWORD."
        )

    return psycopg2.connect(
        host=host, port=port, dbname=db, user=user, password=pwd, sslmode=sslmode,
        cursor_factory=RealDictCursor
    )

def main():
    print("=" * 80)
    print("DXY MIGRATION - PHASE 1: PRE-MIGRATION SAFETY CHECKS")
    print("=" * 80)
    print()

    # 1.1 Environment Check
    print("📋 Step 1.1: Environment Check")
    print("-" * 80)
    
    try:
        conn = get_conn()
        print("✅ Database connection successful")
        
        with conn.cursor() as cur:
            cur.execute("SELECT version();")
            version = cur.fetchone()
            print(f"✅ PostgreSQL version: {version['version'].split(',')[0]}")
        
        print()
    except Exception as e:
        print(f"❌ Database connection failed: {e}")
        print("\nPlease check your environment variables:")
        print("  - PG_DSN (or PGHOST, PGUSER, PGPASSWORD)")
        print("  - Ensure database is accessible")
        sys.exit(1)

    # 1.2 Check Current State
    print("📋 Step 1.2: Check Current State")
    print("-" * 80)
    
    try:
        with conn.cursor() as cur:
            # Check data_bars
            cur.execute("""
                SELECT 
                    'data_bars' as table_name,
                    COUNT(*) as total_rows,
                    COUNT(*) FILTER (WHERE canonical_symbol='DXY' AND timeframe='1m') as dxy_1m_rows
                FROM data_bars;
            """)
            data_bars = cur.fetchone()
            print(f"data_bars:")
            print(f"  Total rows: {data_bars['total_rows']:,}")
            print(f"  DXY 1m rows: {data_bars['dxy_1m_rows']:,}")
            
            # Check derived_data_bars
            cur.execute("""
                SELECT 
                    'derived_data_bars' as table_name,
                    COUNT(*) as total_rows,
                    COUNT(*) FILTER (WHERE canonical_symbol='DXY' AND timeframe='1m' AND deleted_at IS NULL) as dxy_1m_active,
                    COUNT(*) FILTER (WHERE canonical_symbol='DXY' AND timeframe='5m' AND deleted_at IS NULL) as dxy_5m_active,
                    COUNT(*) FILTER (WHERE canonical_symbol='DXY' AND timeframe='1h' AND deleted_at IS NULL) as dxy_1h_active
                FROM derived_data_bars;
            """)
            derived = cur.fetchone()
            print(f"\nderived_data_bars:")
            print(f"  Total rows: {derived['total_rows']:,}")
            print(f"  DXY 1m active rows: {derived['dxy_1m_active']:,}")
            print(f"  DXY 5m active rows: {derived['dxy_5m_active']:,}")
            print(f"  DXY 1h active rows: {derived['dxy_1h_active']:,}")
            
            print()
            
            # Store pre-migration state
            pre_state = {
                'timestamp': datetime.now(timezone.utc).isoformat(),
                'data_bars': {
                    'total': data_bars['total_rows'],
                    'dxy_1m': data_bars['dxy_1m_rows']
                },
                'derived_data_bars': {
                    'total': derived['total_rows'],
                    'dxy_1m_active': derived['dxy_1m_active'],
                    'dxy_5m_active': derived['dxy_5m_active'],
                    'dxy_1h_active': derived['dxy_1h_active']
                }
            }
            
            # Save state to file
            output_dir = Path("artifacts/dxy_migration")
            output_dir.mkdir(parents=True, exist_ok=True)
            
            import json
            state_file = output_dir / "pre_migration_state.json"
            with open(state_file, 'w') as f:
                json.dump(pre_state, f, indent=2)
            
            print(f"✅ Pre-migration state saved to: {state_file}")
            
    except Exception as e:
        print(f"❌ State check failed: {e}")
        conn.rollback()
        sys.exit(1)
    
    # 1.3 Verify Invariants
    print()
    print("📋 Step 1.3: Verify Invariants")
    print("-" * 80)
    
    try:
        with conn.cursor() as cur:
            # Check unique constraint exists
            cur.execute("""
                SELECT constraint_name, constraint_type
                FROM information_schema.table_constraints
                WHERE table_name = 'data_bars'
                  AND constraint_type = 'UNIQUE'
                  AND constraint_name LIKE '%canonical_symbol%'
                LIMIT 1;
            """)
            unique_constraint = cur.fetchone()
            
            if unique_constraint:
                print(f"✅ Unique constraint exists: {unique_constraint['constraint_name']}")
            else:
                print("⚠️  WARNING: No unique constraint found on (canonical_symbol, timeframe, ts_utc)")
                print("   This will be created in Phase 2")
            
            # Check source constraint
            cur.execute("""
                SELECT constraint_name, check_clause
                FROM information_schema.check_constraints
                WHERE constraint_name LIKE '%source%'
                  AND constraint_schema = 'public'
                LIMIT 1;
            """)
            source_constraint = cur.fetchone()
            
            if source_constraint:
                print(f"✅ Source constraint exists")
                print(f"   Current definition: {source_constraint['check_clause'][:80]}...")
            else:
                print("ℹ️  No source constraint found (will be added in Phase 2)")
            
            # Check for existing DXY 1m in data_bars
            cur.execute("""
                SELECT COUNT(*) as count
                FROM data_bars
                WHERE canonical_symbol = 'DXY' AND timeframe = '1m';
            """)
            existing_dxy = cur.fetchone()
            
            if existing_dxy['count'] > 0:
                print(f"⚠️  WARNING: Found {existing_dxy['count']} existing DXY 1m rows in data_bars")
                print("   These will be updated during migration")
            else:
                print("✅ No existing DXY 1m rows in data_bars (clean state)")
    
    except Exception as e:
        print(f"❌ Invariant check failed: {e}")
        conn.rollback()
        sys.exit(1)
    
    finally:
        conn.close()
    
    print()
    print("=" * 80)
    print("✅ PHASE 1 COMPLETE: Pre-Migration Safety Checks Passed")
    print("=" * 80)
    print()
    print("Next step: Review pre_migration_state.json and proceed to Phase 2")
    print("           (Schema validation)")
    print()

if __name__ == "__main__":
    main()
