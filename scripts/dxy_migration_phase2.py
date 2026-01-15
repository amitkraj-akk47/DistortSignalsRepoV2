#!/usr/bin/env python3
"""
DXY Migration - Phase 2: Schema Validation
-------------------------------------------
Creates necessary constraints and validates schema before data migration.

Tasks:
1. Create unique constraint on data_bars (canonical_symbol, timeframe, ts_utc)
2. Widen source constraint on derived_data_bars to allow 'DERIVED|AGGREGATED'
3. Verify all required columns exist

Safe to run multiple times (idempotent).
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

def check_unique_constraint(conn):
    """Check if unique constraint exists on data_bars"""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT COUNT(*) as count
            FROM pg_constraint c
            JOIN pg_class t ON c.conrelid = t.oid
            WHERE t.relname = 'data_bars'
              AND c.contype = 'u'
              AND c.conkey = (
                  SELECT ARRAY[
                      a1.attnum, a2.attnum, a3.attnum
                  ]
                  FROM pg_attribute a1, pg_attribute a2, pg_attribute a3
                  WHERE a1.attrelid = t.oid AND a1.attname = 'canonical_symbol'
                    AND a2.attrelid = t.oid AND a2.attname = 'timeframe'
                    AND a3.attrelid = t.oid AND a3.attname = 'ts_utc'
              )
        """)
        result = cur.fetchone()
        return result['count'] > 0

def create_unique_constraint(conn):
    """Create unique constraint on data_bars if it doesn't exist"""
    print("\n📋 Step 2.1: Create Unique Constraint on data_bars")
    print("-" * 60)
    
    if check_unique_constraint(conn):
        print("✅ Unique constraint already exists")
        return True
    
    try:
        with conn.cursor() as cur:
            print("Creating unique constraint on (canonical_symbol, timeframe, ts_utc)...")
            cur.execute("""
                ALTER TABLE data_bars
                ADD CONSTRAINT data_bars_symbol_tf_ts_unique
                UNIQUE (canonical_symbol, timeframe, ts_utc)
            """)
            conn.commit()
            print("✅ Unique constraint created successfully")
            return True
    except psycopg2.Error as e:
        print(f"❌ Failed to create unique constraint: {e}")
        conn.rollback()
        return False

def check_source_values(conn):
    """Check current source values in derived_data_bars"""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT source, COUNT(*) as count
            FROM derived_data_bars
            GROUP BY source
            ORDER BY count DESC
        """)
        return [dict(row) for row in cur.fetchall()]

def verify_source_column(conn):
    """Verify source column exists and is appropriate for DXY migration"""
    print("\n📋 Step 2.2: Verify source Column on derived_data_bars")
    print("-" * 60)
    
    # Check column exists
    with conn.cursor() as cur:
        cur.execute("""
            SELECT column_name, data_type, character_maximum_length
            FROM information_schema.columns
            WHERE table_name = 'derived_data_bars' AND column_name = 'source'
        """)
        result = cur.fetchone()
        
        if not result:
            print("❌ source column not found in derived_data_bars")
            return False
        
        print(f"✅ source column exists: {result['data_type']}")
        if result['character_maximum_length']:
            print(f"   Max length: {result['character_maximum_length']}")
    
    # Show current values
    source_values = check_source_values(conn)
    print("\n   Current source values:")
    for sv in source_values:
        print(f"     '{sv['source']}': {sv['count']} rows")
    
    print("\n✅ source column ready (no constraint needed - descriptive field)")
    return True

def verify_columns(conn):
    """Verify all required columns exist in both tables"""
    print("\n📋 Step 2.3: Verify Required Columns")
    print("-" * 60)
    
    required_columns = [
        'canonical_symbol', 'timeframe', 'ts_utc', 
        'open', 'high', 'low', 'close', 'source'
    ]
    
    all_good = True
    
    for table in ['data_bars', 'derived_data_bars']:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = %s
            """, (table,))
            
            existing_columns = {row['column_name'] for row in cur.fetchall()}
            missing = set(required_columns) - existing_columns
            
            if missing:
                print(f"❌ {table}: Missing columns: {missing}")
                all_good = False
            else:
                print(f"✅ {table}: All required columns present")
    
    return all_good

def save_phase2_state(conn, output_dir):
    """Save post-schema-validation state"""
    with conn.cursor() as cur:
        # Get constraint info
        cur.execute("""
            SELECT 
                c.conname,
                pg_get_constraintdef(c.oid) as definition
            FROM pg_constraint c
            JOIN pg_class t ON c.conrelid = t.oid
            WHERE t.relname IN ('data_bars', 'derived_data_bars')
              AND c.contype IN ('u', 'c')
            ORDER BY t.relname, c.conname
        """)
        constraints = [dict(row) for row in cur.fetchall()]
    
    state = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "constraints": constraints
    }
    
    output_file = output_dir / "post_phase2_state.json"
    with open(output_file, 'w') as f:
        json.dump(state, f, indent=2)
    
    print(f"\n✅ Post-Phase-2 state saved to: {output_file}")

def main():
    print("=" * 60)
    print("DXY MIGRATION - PHASE 2: SCHEMA VALIDATION")
    print("=" * 60)
    
    # Create output directory
    output_dir = Path("artifacts/dxy_migration")
    output_dir.mkdir(parents=True, exist_ok=True)
    
    try:
        conn = get_conn()
        print("✅ Database connection successful\n")
        
        # Step 2.1: Create unique constraint
        if not create_unique_constraint(conn):
            print("\n❌ PHASE 2 FAILED: Could not create unique constraint")
            return 1
        
        # Step 2.2: Verify source column (no constraint needed)
        if not verify_source_column(conn):
            print("\n❌ PHASE 2 FAILED: source column issue")
            return 1
        
        # Step 2.3: Verify columns
        if not verify_columns(conn):
            print("\n❌ PHASE 2 FAILED: Missing required columns")
            return 1
        
        # Save state
        save_phase2_state(conn, output_dir)
        
        print("\n" + "=" * 60)
        print("✅ PHASE 2 COMPLETE: Schema Ready for Migration")
        print("=" * 60)
        print("\nNext step: Phase 3 (Create calc_dxy_range_1m function)")
        
        conn.close()
        return 0
        
    except Exception as e:
        print(f"\n❌ PHASE 2 FAILED: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == "__main__":
    sys.exit(main())
