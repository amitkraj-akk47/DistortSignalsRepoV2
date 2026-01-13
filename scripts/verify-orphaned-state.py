#!/usr/bin/env python3
"""
Verification script: Check for orphaned data_ingest_state records
Date: 2026-01-13
"""

import os
import sys
from dotenv import load_dotenv

# Try importing psycopg2
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

print("=" * 50)
print("ORPHANED INGEST STATE VERIFICATION")
print("=" * 50)
print()

try:
    conn = psycopg2.connect(pg_dsn)
    cursor = conn.cursor()
    
    # Query 1: Total ingest state records
    print("1. Total data_ingest_state records:")
    cursor.execute("SELECT COUNT(*) FROM data_ingest_state;")
    total = cursor.fetchone()[0]
    print(f"   {total} records\n")
    
    # Query 2: Orphaned records count
    print("2. Orphaned records (disabled assets with lingering state):")
    cursor.execute("""
        SELECT COUNT(*) FROM data_ingest_state dis
        WHERE NOT EXISTS (
            SELECT 1 FROM core_asset_registry_all car
            WHERE dis.canonical_symbol = car.canonical_symbol
              AND (car.active = true OR car.test_active = true)
        );
    """)
    orphaned_count = cursor.fetchone()[0]
    print(f"   {orphaned_count} orphaned records\n")
    
    if orphaned_count > 0:
        print("   ⚠️  CONFIRMED: Orphaned records exist!")
        print()
        
        # Query 3: List orphaned records
        print("3. Details of orphaned records:")
        cursor.execute("""
            SELECT 
                dis.canonical_symbol,
                dis.timeframe,
                dis.status,
                dis.hard_fail_streak,
                dis.updated_at
            FROM data_ingest_state dis
            WHERE NOT EXISTS (
                SELECT 1 FROM core_asset_registry_all car
                WHERE dis.canonical_symbol = car.canonical_symbol
                  AND (car.active = true OR car.test_active = true)
            )
            ORDER BY dis.canonical_symbol;
        """)
        
        records = cursor.fetchall()
        print(f"\n   Found {len(records)} orphaned records:")
        print()
        print(f"   {'Symbol':<15} {'TF':<5} {'Status':<15} {'Streak':<7} {'Updated':<20}")
        print("   " + "-" * 70)
        
        for row in records:
            symbol, tf, status, streak, updated_at = row
            print(f"   {symbol:<15} {tf:<5} {status:<15} {streak:<7} {str(updated_at)[:19]}")
        
        print()
    else:
        print("   ✅ No orphaned records found\n")
    
    # Query 4: Disabled assets with running state
    print("4. Disabled assets with state marked as 'running':")
    cursor.execute("""
        SELECT COUNT(*)
        FROM data_ingest_state dis
        JOIN core_asset_registry_all car ON dis.canonical_symbol = car.canonical_symbol
        WHERE (car.active = false AND car.test_active = false)
          AND dis.status = 'running';
    """)
    disabled_running = cursor.fetchone()[0]
    print(f"   {disabled_running} disabled assets with 'running' state\n")
    
    if disabled_running > 0:
        print("   ⚠️  POTENTIAL ISSUE: Some disabled assets still marked as running")
        cursor.execute("""
            SELECT 
                dis.canonical_symbol,
                dis.timeframe,
                dis.status,
                car.active,
                car.test_active
            FROM data_ingest_state dis
            JOIN core_asset_registry_all car ON dis.canonical_symbol = car.canonical_symbol
            WHERE (car.active = false AND car.test_active = false)
              AND dis.status = 'running'
            LIMIT 10;
        """)
        
        for row in cursor.fetchall():
            symbol, tf, status, active, test_active = row
            print(f"   - {symbol} ({tf}): status={status}, active={active}, test_active={test_active}")
        print()
    
    cursor.close()
    conn.close()
    
    print("=" * 50)
    print("VERIFICATION COMPLETE")
    print("=" * 50)
    print()
    
    # Summary
    if orphaned_count > 0:
        print("✅ DIAGNOSIS CONFIRMED:")
        print(f"   Found {orphaned_count} orphaned ingest state records")
        print("   These are from assets that have been disabled")
        print("   Recommend running migration 007_cleanup_orphaned_ingest_state.sql")
    else:
        print("✅ DATABASE STATE IS CLEAN")
        print("   No orphaned records detected")

except psycopg2.Error as e:
    print(f"❌ Database connection failed: {e}")
    print()
    print("Make sure:")
    print("  1. Database is accessible from this machine")
    print("  2. PG_DSN in scripts/.env is correct")
    print("  3. Network/firewall allows connection")
    sys.exit(1)
