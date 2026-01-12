#!/usr/bin/env python3
"""
Validate Worker Runtime vs Lock Lease

Purpose: Check if Worker runtime exceeds lock lease duration (150s default),
         which would cause lock expiry mid-run and potential overlap.

Usage:
    python scripts/validate_worker_runtime.py

Requirements:
    - PG_DSN environment variable set
    - Access to ops_job_runs table (Worker execution logs)
"""

import os
import sys
from datetime import datetime, timedelta
from typing import Optional

import psycopg2
from dotenv import load_dotenv

load_dotenv()

# Configuration
LOCK_LEASE_SECONDS = 150  # Default from Worker config
WARNING_THRESHOLD_SECONDS = 120  # Warn if within 30s of lease expiry
CRITICAL_THRESHOLD_SECONDS = 150  # Critical if exceeds lease


def query_recent_worker_runs(conn, limit: int = 20) -> list[dict]:
    """Query recent Worker runs from ops_job_runs table."""
    query = """
        SELECT 
            id,
            job_name,
            status,
            created_at,
            updated_at,
            EXTRACT(EPOCH FROM (updated_at - created_at)) as duration_seconds,
            (metadata->>'duration_ms')::numeric / 1000.0 as duration_from_metadata,
            (metadata->>'assets_succeeded')::int as assets_succeeded,
            (metadata->>'assets_total')::int as assets_total,
            (metadata->>'rows_written')::int as rows_written,
            metadata->>'lease_seconds' as lease_seconds
        FROM ops_job_runs
        WHERE job_name LIKE '%ingest%'
          AND status IN ('completed', 'failed')
        ORDER BY created_at DESC
        LIMIT %s
    """
    
    with conn.cursor() as cur:
        cur.execute(query, (limit,))
        cols = [desc[0] for desc in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def analyze_runtime_safety(runs: list[dict]) -> dict:
    """Analyze if runtime is safe relative to lock lease."""
    if not runs:
        return {
            'status': 'ERROR',
            'message': 'No recent Worker runs found in ops_job_runs table',
        }
    
    # Use metadata duration if available (more accurate), else updated_at - created_at
    durations = []
    for run in runs:
        duration = run.get('duration_from_metadata') or run.get('duration_seconds')
        if duration is not None:
            durations.append(float(duration))
    
    if not durations:
        return {
            'status': 'ERROR',
            'message': 'No duration data found in Worker runs',
        }
    
    durations.sort()
    p50 = durations[len(durations) // 2]
    p95 = durations[int(len(durations) * 0.95)] if len(durations) > 1 else durations[0]
    p99 = durations[int(len(durations) * 0.99)] if len(durations) > 2 else durations[-1]
    max_duration = max(durations)
    
    # Determine safety status
    if max_duration < WARNING_THRESHOLD_SECONDS:
        status = 'SAFE'
        level = '✅'
    elif max_duration < CRITICAL_THRESHOLD_SECONDS:
        status = 'WARNING'
        level = '⚠️'
    else:
        status = 'CRITICAL'
        level = '🚨'
    
    return {
        'status': status,
        'level': level,
        'count': len(durations),
        'p50': p50,
        'p95': p95,
        'p99': p99,
        'max': max_duration,
        'lock_lease': LOCK_LEASE_SECONDS,
        'warning_threshold': WARNING_THRESHOLD_SECONDS,
        'critical_threshold': CRITICAL_THRESHOLD_SECONDS,
        'latest_run': runs[0],
    }


def print_analysis(analysis: dict) -> None:
    """Print runtime analysis with color-coded output."""
    if analysis['status'] == 'ERROR':
        print(f"\n🚨 ERROR: {analysis['message']}\n")
        return
    
    level = analysis['level']
    status = analysis['status']
    
    print("\n" + "="*70)
    print(f"  {level} WORKER RUNTIME VALIDATION - {status}")
    print("="*70)
    
    print(f"\n📊 RUNTIME STATISTICS (from {analysis['count']} recent runs):")
    print(f"   p50 (median): {analysis['p50']:.1f}s")
    print(f"   p95:          {analysis['p95']:.1f}s")
    print(f"   p99:          {analysis['p99']:.1f}s")
    print(f"   max:          {analysis['max']:.1f}s")
    
    print(f"\n🔒 LOCK LEASE CONFIGURATION:")
    print(f"   Lease duration:     {analysis['lock_lease']}s")
    print(f"   Warning threshold:  {analysis['warning_threshold']}s (80% of lease)")
    print(f"   Critical threshold: {analysis['critical_threshold']}s (lease expiry)")
    
    print(f"\n📈 SAFETY ASSESSMENT:")
    
    if status == 'SAFE':
        print(f"   {level} SAFE: All runs completed well within lock lease duration")
        print(f"   • Max runtime ({analysis['max']:.1f}s) < {analysis['warning_threshold']}s threshold")
        print(f"   • No risk of lock expiry mid-run")
        print(f"   • Safe to proceed with bounded concurrency implementation")
    
    elif status == 'WARNING':
        print(f"   {level} WARNING: Runtime approaching lock lease limit")
        print(f"   • Max runtime ({analysis['max']:.1f}s) is {analysis['max'] - analysis['lock_lease']:.1f}s from lease expiry")
        print(f"   • Risk of lock expiry if runtime increases further")
        print(f"   • Recommend increasing LOCK_LEASE_SECONDS to 300-600s")
        print(f"   • Or add MAX_RUN_BUDGET_MS cap at 120000ms (2 min)")
    
    else:  # CRITICAL
        print(f"   {level} CRITICAL: Runtime EXCEEDS lock lease duration!")
        print(f"   • Max runtime ({analysis['max']:.1f}s) > {analysis['lock_lease']}s lease")
        print(f"   • Lock expires mid-run → another instance can acquire lock")
        print(f"   • POTENTIAL OVERLAP RISK (though lock prevents most cases)")
        print(f"   • MUST FIX BEFORE deploying bounded concurrency")
        print(f"\n   🔧 REQUIRED ACTION:")
        print(f"      wrangler secret put LOCK_LEASE_SECONDS")
        print(f"      # Recommended value: 300 (5 min) or 600 (10 min)")
    
    print(f"\n📝 LATEST RUN DETAILS:")
    latest = analysis['latest_run']
    print(f"   Run ID:     {latest['id']}")
    print(f"   Job:        {latest['job_name']}")
    print(f"   Status:     {latest['status']}")
    print(f"   Started:    {latest['created_at']}")
    print(f"   Duration:   {latest.get('duration_from_metadata') or latest.get('duration_seconds'):.1f}s")
    print(f"   Assets:     {latest.get('assets_succeeded', 0)}/{latest.get('assets_total', 0)} succeeded")
    print(f"   Rows:       {latest.get('rows_written', 0):,} written")
    
    print("\n" + "="*70)
    
    # Exit code based on status
    if status == 'CRITICAL':
        print("\n⚠️  Exit code 2: CRITICAL - Fix required before proceeding\n")
        sys.exit(2)
    elif status == 'WARNING':
        print("\n⚠️  Exit code 1: WARNING - Consider increasing lock lease\n")
        sys.exit(1)
    else:
        print("\n✅ Exit code 0: SAFE - Proceed with implementation\n")
        sys.exit(0)


def main():
    """Main execution."""
    pg_dsn = os.getenv('PG_DSN')
    if not pg_dsn:
        print("❌ ERROR: PG_DSN environment variable not set")
        print("   Load from .env or set manually:")
        print("   export PG_DSN='postgresql://user:pass@host:5432/dbname'")
        sys.exit(1)
    
    try:
        print("🔌 Connecting to database...")
        conn = psycopg2.connect(pg_dsn)
        
        print("📊 Querying recent Worker runs...")
        runs = query_recent_worker_runs(conn, limit=20)
        
        print("🔍 Analyzing runtime safety...")
        analysis = analyze_runtime_safety(runs)
        
        print_analysis(analysis)
        
    except psycopg2.Error as e:
        print(f"\n❌ Database error: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        if 'conn' in locals():
            conn.close()


if __name__ == '__main__':
    main()
