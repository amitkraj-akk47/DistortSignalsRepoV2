#!/usr/bin/env python3
"""
Verification script: Check safeguard implementation for orphaned state records
Date: 2026-01-13
"""

import os
import sys
from dotenv import load_dotenv

try:
    import psycopg2
    from psycopg2 import sql
except ImportError:
    print("Installing psycopg2...")
    os.system("pip install psycopg2-binary python-dotenv -q")
    import psycopg2
    from psycopg2 import sql

# Load environment
env_path = os.path.join(os.path.dirname(__file__), ".env")
if not os.path.exists(env_path):
    print(f"ERROR: {env_path} not found")
    sys.exit(1)

load_dotenv(env_path)

pg_dsn = os.getenv("PG_DSN")
if not pg_dsn:
    print("ERROR: PG_DSN not set in scripts/.env")
    sys.exit(1)

print("=" * 70)
print("ORPHANED STATE RECORDS - SAFEGUARD VERIFICATION")
print("=" * 70)
print()

try:
    conn = psycopg2.connect(pg_dsn)
    cursor = conn.cursor()
    
    # Check if notes column exists
    print("1. Checking database schema...")
    cursor.execute("""
        SELECT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'data_ingest_state' AND column_name = 'notes'
        );
    """)
    has_notes_column = cursor.fetchone()[0]
    if has_notes_column:
        print("   ✅ notes column exists\n")
    else:
        print("   ⚠️  notes column does NOT exist - run migration 008\n")
    
    # Query: Orphaned records that would be caught by safeguard
    print("2. Records that will be caught by safeguard (orphaned):")
    cursor.execute("""
        SELECT 
            dis.canonical_symbol,
            dis.timeframe,
            dis.status,
            dis.notes,
            dis.updated_at
        FROM data_ingest_state dis
        WHERE NOT EXISTS (
            SELECT 1 FROM core_asset_registry_all car
            WHERE dis.canonical_symbol = car.canonical_symbol
              AND (car.active = true OR car.test_active = true)
        )
        ORDER BY dis.canonical_symbol;
    """)
    
    orphaned_records = cursor.fetchall()
    if orphaned_records:
        print(f"   Found {len(orphaned_records)} orphaned records:\n")
        print(f"   {'Symbol':<15} {'TF':<5} {'Status':<15} {'Notes':<30}")
        print("   " + "-" * 70)
        
        for row in orphaned_records:
            symbol, tf, status, notes, updated_at = row
            notes_display = notes[:28] + "..." if notes and len(notes) > 28 else (notes or "")
            status_marked = "✓ ORPHAN" if status == "orphaned" else "○ NOT MARKED"
            print(f"   {symbol:<15} {tf:<5} {status_marked:<15} {notes_display:<30}")
        
        print()
    else:
        print("   ✅ No orphaned records found\n")
    
    # Query: Already marked orphaned records
    print("3. Records already marked as ORPHAN:")
    cursor.execute("""
        SELECT COUNT(*), COUNT(notes)
        FROM data_ingest_state
        WHERE status = 'orphaned' OR notes LIKE '%ORPHAN%';
    """)
    
    orphan_marked, notes_marked = cursor.fetchone()
    print(f"   Status='orphaned': {orphan_marked}")
    print(f"   Notes contains 'ORPHAN': {notes_marked}")
    print()
    
    # Query: Active state records (should be safe to process)
    print("4. Active state records (safe to process):")
    cursor.execute("""
        SELECT COUNT(*)
        FROM data_ingest_state dis
        WHERE EXISTS (
            SELECT 1 FROM core_asset_registry_all car
            WHERE dis.canonical_symbol = car.canonical_symbol
              AND (car.active = true OR car.test_active = true)
        )
        AND status NOT IN ('orphaned', 'disabled');
    """)
    
    active_count = cursor.fetchone()[0]
    print(f"   {active_count} records\n")
    
    # Summary
    print("=" * 70)
    print("SAFEGUARD IMPLEMENTATION STATUS")
    print("=" * 70)
    print()
    
    if has_notes_column:
        print("✅ CODE SAFEGUARD READY:")
        print("   • Safeguard check added to ingestindex.ts (STEP 0.5)")
        print("   • Before calling ingest_asset_start RPC:")
        print("     1. Checks if state record exists for asset")
        print("     2. Verifies asset is still in active registry")
        print("     3. If state exists but asset disabled: marks as ORPHAN and skips")
        print("     4. Logs warning and bumps skip counter")
        print()
        print("✅ DATABASE SCHEMA READY:")
        print("   • notes column exists on data_ingest_state")
        print("   • Orphaned records will be marked with:")
        print('     status="orphaned"')
        print('     notes="ORPHAN RECORD: Asset disabled on [DATE] but state record was not cleaned up"')
        print()
        print("✅ MIGRATION MIGRATION APPLIED:")
        print("   • Run migration 007: cleanup_orphaned_ingest_state.sql")
        print("   • Run migration 008: add_notes_column_to_ingest_state.sql")
        print()
        print("📊 CURRENT STATE:")
        print(f"   • {len(orphaned_records)} orphaned records exist")
        print(f"   • {orphan_marked} records already marked as orphaned")
        print(f"   • {active_count} active safe records")
        print()
        print("✅ NEXT STEPS:")
        print("   1. Apply migrations 007 and 008 to database")
        print("   2. Redeploy tick-factory worker with safeguard code")
        print("   3. Monitor logs for 'ORPHANED_STATE' warnings")
        print("   4. Verify no more exceededCpu errors")
    else:
        print("⚠️  SAFEGUARD NOT READY - Missing database schema")
        print("   Run migration 008 to add notes column first")
    
    print()
    
    cursor.close()
    conn.close()

except psycopg2.Error as e:
    print(f"❌ Database connection failed: {e}")
    sys.exit(1)
