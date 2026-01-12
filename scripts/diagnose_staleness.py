#!/usr/bin/env python3
"""
Step 1A: Staleness Diagnostic Tool

Identifies ingestion issues, cursor advancement problems, and data gaps.
Provides actionable recommendations for fixing staleness issues.

USAGE:
  python diagnose_staleness.py

ENV REQUIRED:
  PG_DSN or PGHOST/PGUSER/PGPASSWORD/PGDATABASE
"""

import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
    from dotenv import load_dotenv
    import pandas as pd
except ImportError as e:
    print(f"ERROR: Missing dependency: {e}")
    print("Install: pip install psycopg2-binary pandas python-dotenv")
    sys.exit(1)

load_dotenv()

def get_conn():
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
        raise RuntimeError(f"Missing DB env vars: {', '.join(missing)}")

    return psycopg2.connect(
        host=host, port=port, dbname=db, user=user, password=pwd, sslmode=sslmode,
        cursor_factory=RealDictCursor
    )

def run_query(conn, query, params=None):
    with conn.cursor() as cur:
        cur.execute(query, params or {})
        return cur.fetchall()

def check_staleness(conn):
    """Check current staleness per asset."""
    print("\n" + "=" * 80)
    print("1. CURRENT STALENESS BY ASSET")
    print("=" * 80)
    
    query = """
        SELECT 
            canonical_symbol,
            MAX(ts_utc) as latest_bar,
            NOW() AT TIME ZONE 'UTC' as now_utc,
            EXTRACT(EPOCH FROM (NOW() AT TIME ZONE 'UTC' - MAX(ts_utc))) / 60 as staleness_minutes
        FROM data_bars
        WHERE timeframe = '1m'
        GROUP BY canonical_symbol
        ORDER BY staleness_minutes DESC
    """
    
    results = run_query(conn, query)
    if not results:
        print("⚠ No data found in data_bars table")
        return None
    
    df = pd.DataFrame(results)
    print(df.to_string(index=False))
    
    max_stale = df['staleness_minutes'].max()
    avg_stale = df['staleness_minutes'].mean()
    
    print(f"\n📊 Summary:")
    print(f"  Max staleness: {max_stale:.1f} minutes")
    print(f"  Avg staleness: {avg_stale:.1f} minutes")
    
    if max_stale > 15:
        print(f"  ❌ CRITICAL: Staleness exceeds 15 minutes")
    elif max_stale > 8:
        print(f"  ⚠ WARNING: Staleness exceeds 8 minutes")
    elif max_stale > 5:
        print(f"  ⚠ MINOR: Staleness exceeds 5 minutes")
    else:
        print(f"  ✓ OK: Staleness within acceptable range")
    
    return df

def check_recent_ingestion(conn):
    """Check if data is being ingested in the last few hours."""
    print("\n" + "=" * 80)
    print("2. BARS INSERTED PER HOUR (LAST 24 HOURS)")
    print("=" * 80)
    
    query = """
        SELECT 
            DATE_TRUNC('hour', ts_utc) as hour,
            canonical_symbol,
            COUNT(*) as bars_inserted
        FROM data_bars
        WHERE timeframe = '1m'
          AND ts_utc >= NOW() - INTERVAL '24 hours'
        GROUP BY DATE_TRUNC('hour', ts_utc), canonical_symbol
        ORDER BY hour DESC, canonical_symbol
        LIMIT 50
    """
    
    results = run_query(conn, query)
    if not results:
        print("⚠ No recent ingestion data")
        return
    
    df = pd.DataFrame(results)
    print(df.to_string(index=False))
    
    # Check last hour
    latest_hour = df['hour'].max()
    last_hour_df = df[df['hour'] == latest_hour]
    
    print(f"\n📊 Last hour ({latest_hour}):")
    print(f"  Assets with data: {len(last_hour_df)}")
    print(f"  Avg bars per asset: {last_hour_df['bars_inserted'].mean():.1f}")
    print(f"  Expected: ~60 bars/asset/hour during market hours")

def check_gaps(conn):
    """Check for gaps >5 minutes in the last 24 hours."""
    print("\n" + "=" * 80)
    print("3. GAPS DETECTED (>5 MIN) IN LAST 24 HOURS")
    print("=" * 80)
    
    query = """
        WITH bars_with_lag AS (
            SELECT 
                canonical_symbol,
                ts_utc,
                LAG(ts_utc) OVER (PARTITION BY canonical_symbol ORDER BY ts_utc) as prev_ts
            FROM data_bars
            WHERE timeframe = '1m'
              AND ts_utc >= NOW() - INTERVAL '24 hours'
        )
        SELECT 
            canonical_symbol,
            prev_ts,
            ts_utc,
            ts_utc - prev_ts as gap_duration,
            EXTRACT(EPOCH FROM (ts_utc - prev_ts)) / 60 as gap_minutes
        FROM bars_with_lag
        WHERE prev_ts IS NOT NULL
          AND (ts_utc - prev_ts) > INTERVAL '5 minutes'
        ORDER BY gap_duration DESC
        LIMIT 20
    """
    
    results = run_query(conn, query)
    if not results:
        print("✓ No significant gaps detected")
        return
    
    df = pd.DataFrame(results)
    print(df.to_string(index=False))
    
    print(f"\n📊 Summary:")
    print(f"  Total gaps: {len(df)}")
    print(f"  Largest gap: {df['gap_minutes'].max():.1f} minutes")

def check_data_freshness_trend(conn):
    """Check if staleness is getting worse over time."""
    print("\n" + "=" * 80)
    print("4. STALENESS TREND (LAST 6 HOURS)")
    print("=" * 80)
    
    query = """
        WITH hourly_max AS (
            SELECT 
                DATE_TRUNC('hour', ts_utc) as hour,
                canonical_symbol,
                MAX(ts_utc) as max_ts_in_hour
            FROM data_bars
            WHERE timeframe = '1m'
              AND ts_utc >= NOW() - INTERVAL '6 hours'
            GROUP BY DATE_TRUNC('hour', ts_utc), canonical_symbol
        )
        SELECT 
            hour,
            canonical_symbol,
            max_ts_in_hour,
            EXTRACT(EPOCH FROM (
                LEAD(hour) OVER (PARTITION BY canonical_symbol ORDER BY hour) - max_ts_in_hour
            )) / 60 as minutes_until_next_hour
        FROM hourly_max
        ORDER BY canonical_symbol, hour DESC
    """
    
    results = run_query(conn, query)
    if not results:
        print("⚠ Insufficient data for trend analysis")
        return
    
    df = pd.DataFrame(results)
    print(df.head(30).to_string(index=False))

def generate_recommendations(staleness_df):
    """Generate actionable recommendations."""
    print("\n" + "=" * 80)
    print("RECOMMENDATIONS")
    print("=" * 80)
    
    if staleness_df is None or staleness_df.empty:
        print("\n❌ CRITICAL: No data in database")
        print("\nActions:")
        print("  1. Verify ingestion worker is deployed and running")
        print("  2. Check Cloudflare Workers logs")
        print("  3. Verify database connection from worker")
        return
    
    max_stale = staleness_df['staleness_minutes'].max()
    
    if max_stale > 15:
        print("\n❌ CRITICAL ISSUE: Staleness > 15 minutes")
        print("\nImmediate actions:")
        print("  1. Check Cloudflare Worker cron trigger:")
        print("     - Navigate to Workers & Pages > your-worker > Triggers")
        print("     - Verify cron schedule is active (should run every 1-3 minutes)")
        print("  2. Check recent Worker invocations:")
        print("     - Workers & Pages > your-worker > Logs")
        print("     - Look for errors or timeouts")
        print("  3. Verify provider API:")
        print("     - Check if Massive.com API is responding")
        print("     - Review rate limit status")
        print("  4. Check database connectivity:")
        print("     - Verify worker can connect to Supabase")
        print("     - Check for connection pool exhaustion")
        
    elif max_stale > 8:
        print("\n⚠ WARNING: Staleness > 8 minutes")
        print("\nSuggested actions:")
        print("  1. Review Worker execution frequency:")
        print("     - Current interval may be too long")
        print("     - Consider increasing to every 2 minutes")
        print("  2. Check for slow API responses:")
        print("     - Review Worker execution duration")
        print("     - Optimize data fetching if needed")
        print("  3. Monitor for pattern:")
        print("     - Is staleness consistent or intermittent?")
        print("     - Does it correlate with specific times?")
        
    elif max_stale > 5:
        print("\n⚠ MINOR: Staleness > 5 minutes")
        print("\nAcceptable but worth monitoring:")
        print("  1. This is within normal operational variance")
        print("  2. Monitor for 24 hours to establish baseline")
        print("  3. Set alert threshold at 10 minutes")
        
    else:
        print("\n✓ HEALTHY: Staleness within acceptable range")
        print("\nContinue monitoring:")
        print("  1. Maintain current configuration")
        print("  2. Set up alerting for staleness > 10 minutes")
        print("  3. Review weekly for trends")

def main():
    print("DistortSignals Staleness Diagnostic Tool")
    print("=" * 80)
    print(f"Run time: {datetime.now(timezone.utc).isoformat()}")
    
    try:
        conn = get_conn()
        print("✓ Connected to database")
    except Exception as e:
        print(f"❌ Failed to connect: {e}")
        sys.exit(1)
    
    try:
        staleness_df = check_staleness(conn)
        check_recent_ingestion(conn)
        check_gaps(conn)
        check_data_freshness_trend(conn)
        generate_recommendations(staleness_df)
        
        print("\n" + "=" * 80)
        print("Diagnostic complete. Review recommendations above.")
        print("=" * 80)
        
    except Exception as e:
        print(f"\n❌ Error during diagnostics: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        conn.close()

if __name__ == "__main__":
    main()
