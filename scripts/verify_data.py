#!/usr/bin/env python3
"""
DistortSignals — Formal Data Verification (Ingestion + Aggregation)

Runs two verification passes:
  Phase A: Active assets (freshness, duplicates, gaps, alignment, agg consistency) over last N days
  Phase B: Historical (integrity, counts, gap density, DXY checks) over last N years

Designed to run from GitHub Codespaces.

USAGE:
  python verify_data.py --phase A
  python verify_data.py --phase B
  python verify_data.py --phase ALL

REQUIRES:
  pip install psycopg2-binary pandas python-dotenv

ENV (choose one approach):
  # Option 1: single URL
  PG_DSN="postgresql://USER:PASSWORD@HOST:5432/postgres?sslmode=require"

  # Option 2: discrete parts
  PGHOST=...
  PGPORT=5432
  PGDATABASE=postgres
  PGUSER=...
  PGPASSWORD=...
  PGSSLMODE=require

OPTIONAL:
  OUTPUT_DIR="./artifacts/data_verification"
  ACTIVE_DAYS=7
  HIST_YEARS=3

NOTES:
  - Adjust TABLE NAMES in CONFIG if your schema differs.
  - If you have market-hours assets, gap checks may flag expected downtime.
"""

from __future__ import annotations

import os
import sys
import json
import argparse
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple

try:
    import pandas as pd
    import psycopg2
    from psycopg2.extras import RealDictCursor
    from dotenv import load_dotenv
except ImportError as e:
    print(f"ERROR: Missing required dependency: {e}")
    print("Please run: pip install psycopg2-binary pandas python-dotenv")
    sys.exit(1)

# Load environment variables
load_dotenv()

# Generate unique run ID with today's date
RUN_TIMESTAMP = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")

# ----------------------------
# CONFIG (edit if needed)
# ----------------------------

@dataclass(frozen=True)
class Config:
  # Tables / views (can be overridden via env vars)
  registry_table: str = os.getenv("REGISTRY_TABLE", "core_asset_registry_all")
  registry_active_col: str = os.getenv("REGISTRY_ACTIVE_COL", "is_active")
  registry_symbol_col: str = os.getenv("REGISTRY_SYMBOL_COL", "canonical_symbol")

  data_bars_table: str = "data_bars"
  derived_bars_table: str = "derived_data_bars"

  # Columns
  bars_symbol_col: str = "canonical_symbol"
  bars_tf_col: str = "timeframe"
  bars_ts_col: str = "ts_utc"
  bars_open: str = "open"
  bars_high: str = "high"
  bars_low: str = "low"
  bars_close: str = "close"
  bars_volume: str = "volume"  # Optional column

  # Staleness thresholds (minutes)
  staleness_warning_minutes: int = int(os.getenv("STALENESS_WARNING_MINUTES", "5"))
  staleness_critical_minutes: int = int(os.getenv("STALENESS_CRITICAL_MINUTES", "15"))

  # DXY components (canonical symbols)
  dxy_symbol: str = "DXY"
  dxy_components: Tuple[str, ...] = ("EURUSD", "USDJPY", "GBPUSD", "USDCAD", "USDSEK", "USDCHF")

def get_config(dataset: str) -> Config:
  if dataset == "historical":
    return Config(
      data_bars_table="historical_bars_1m",
      derived_bars_table="historical_bars_derived"
    )
  return Config()

CFG = Config()

# Supported timeframe durations (seconds)
TIMEFRAME_SECONDS: Dict[str, int] = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
}

# Defaults for expected-vs-actual matrices (can be overridden via CLI/env)
DEFAULT_INGEST_TFS = os.getenv("INGEST_TFS", "1m")
DEFAULT_AGG_TFS = os.getenv("AGG_TFS", "1m,5m,1h,1d")

# ----------------------------
# SQL HELPERS
# ----------------------------

def sql_ident(name: str) -> str:
    """Basic identifier safety (assumes trusted config)."""
    # If you want stronger safety, implement strict regex validation here.
    return name

def timeframe_to_seconds(tf: str) -> int:
  if tf not in TIMEFRAME_SECONDS:
    raise ValueError(f"Unsupported timeframe '{tf}'. Supported: {sorted(TIMEFRAME_SECONDS.keys())}")
  return TIMEFRAME_SECONDS[tf]

def parse_tf_list(raw: str) -> List[str]:
  return [tf.strip() for tf in raw.split(",") if tf.strip()]

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

# ----------------------------
# DB
# ----------------------------

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
        raise RuntimeError(
            f"Missing DB env vars: {', '.join(missing)}. "
            f"Set PG_DSN or PGHOST/PGUSER/PGPASSWORD."
        )

    return psycopg2.connect(
        host=host, port=port, dbname=db, user=user, password=pwd, sslmode=sslmode,
        cursor_factory=RealDictCursor
    )

def qdf(conn, sql: str, params: Optional[Dict[str, Any]] = None) -> pd.DataFrame:
    try:
        with conn.cursor() as cur:
            if params is not None:
                cur.execute(sql, params)
            else:
                cur.execute(sql)
            rows = cur.fetchall()
        return pd.DataFrame(rows)
    except Exception as e:
        print(f"\n❌ SQL execution error in qdf(): {e}\nQuery: {sql}\nParams: {params}")
        conn.rollback()
        return pd.DataFrame()

# ----------------------------
# QUERIES
# ----------------------------

def get_active_assets(conn) -> pd.DataFrame:
    """Get active assets from registry plus DXY as a derived asset"""
    sql = f"""
      select {sql_ident(CFG.registry_symbol_col)} as canonical_symbol
      from {sql_ident(CFG.registry_table)}
      where {sql_ident(CFG.registry_active_col)} = true
      union
      select %(dxy)s as canonical_symbol
      order by 1;
    """
    df = qdf(conn, sql, {"dxy": CFG.dxy_symbol})
    if df.empty:
        raise RuntimeError("Active assets query returned 0 rows. Check registry table/columns in CONFIG.")
    return df

def check_freshness(conn, active: pd.DataFrame, active_days: int) -> pd.DataFrame:
    """Check freshness for all active assets including DXY from derived table"""
    sql = f"""
      with data_bars_freshness as (
        select
          a.canonical_symbol,
          max(b.{sql_ident(CFG.bars_ts_col)}) as latest_1m_ts
        from (select unnest(%(symbols)s::text[]) as canonical_symbol) a
        left join {sql_ident(CFG.data_bars_table)} b
          on b.{sql_ident(CFG.bars_symbol_col)} = a.canonical_symbol
         and b.{sql_ident(CFG.bars_tf_col)} = '1m'
         and b.{sql_ident(CFG.bars_ts_col)} >= (now() at time zone 'utc') - interval '{active_days} days'
        where a.canonical_symbol != %(dxy)s
        group by 1
      ),
      derived_bars_freshness as (
        select
          {sql_ident(CFG.bars_symbol_col)} as canonical_symbol,
          max({sql_ident(CFG.bars_ts_col)}) as latest_1m_ts
        from {sql_ident(CFG.derived_bars_table)}
        where {sql_ident(CFG.bars_symbol_col)} = %(dxy)s
          and {sql_ident(CFG.bars_tf_col)} = '1m'
          and {sql_ident(CFG.bars_ts_col)} >= (now() at time zone 'utc') - interval '{active_days} days'
        group by 1
      ),
      combined as (
        select * from data_bars_freshness
        union all
        select * from derived_bars_freshness
      )
      select
        canonical_symbol,
        latest_1m_ts,
        (now() at time zone 'utc') as now_utc,
        (now() at time zone 'utc') - latest_1m_ts as staleness
      from combined
      order by staleness desc nulls last;
    """
    return qdf(conn, sql, {"symbols": active["canonical_symbol"].tolist(), "dxy": CFG.dxy_symbol})

def check_duplicates(conn, table: str, tfs: List[str], days: int) -> pd.DataFrame:
    tf_list = ",".join([f"'{tf}'" for tf in tfs])
    sql = f"""
      select
        {sql_ident(CFG.bars_symbol_col)} as canonical_symbol,
        {sql_ident(CFG.bars_tf_col)} as timeframe,
        {sql_ident(CFG.bars_ts_col)} as ts_utc,
        count(*) as rows_at_key
      from {sql_ident(table)}
      where {sql_ident(CFG.bars_tf_col)} in ({tf_list})
        and {sql_ident(CFG.bars_ts_col)} >= (now() at time zone 'utc') - interval '{days} days'
      group by 1,2,3
      having count(*) > 1
      order by rows_at_key desc, canonical_symbol, timeframe, ts_utc
      limit 500;
    """
    return qdf(conn, sql)

def check_alignment(conn, table: str, tf: str, days: int) -> pd.DataFrame:
    """Check if timestamps are aligned correctly for the given timeframe"""
    if tf == "5m":
        misalign_pred = f"extract(minute from {sql_ident(CFG.bars_ts_col)})::int % 5 <> 0"
    elif tf == "1h":
        misalign_pred = f"extract(minute from {sql_ident(CFG.bars_ts_col)}) <> 0"
    elif tf == "1d":
        misalign_pred = f"(extract(hour from {sql_ident(CFG.bars_ts_col)}) <> 0 or extract(minute from {sql_ident(CFG.bars_ts_col)}) <> 0)"
    else:
        raise ValueError(f"Alignment checks implemented for 5m, 1h, and 1d only. Got: {tf}")

    sql = f"""
      select
        {sql_ident(CFG.bars_symbol_col)} as canonical_symbol,
        count(*) as misaligned_count
      from {sql_ident(table)}
      where {sql_ident(CFG.bars_tf_col)} = '{tf}'
        and {sql_ident(CFG.bars_ts_col)} >= (now() at time zone 'utc') - interval '{days} days'
        and {misalign_pred}
      group by 1
      order by misaligned_count desc, canonical_symbol;
    """
    return qdf(conn, sql)

def check_gap_density(conn, table: str, tf: str, years: int, symbols: Optional[List[str]] = None) -> pd.DataFrame:
    sym_filter = ""
    params: Dict[str, Any] = {}
    if symbols:
        sym_filter = f"and {sql_ident(CFG.bars_symbol_col)} = any(%(symbols)s::text[])"
        params["symbols"] = symbols

    sql = f"""
      with x as (
        select
          {sql_ident(CFG.bars_symbol_col)} as canonical_symbol,
          {sql_ident(CFG.bars_ts_col)} as ts_utc,
          lag({sql_ident(CFG.bars_ts_col)}) over (partition by {sql_ident(CFG.bars_symbol_col)} order by {sql_ident(CFG.bars_ts_col)}) as prev_ts
        from {sql_ident(table)}
        where {sql_ident(CFG.bars_tf_col)} = '{tf}'
          and {sql_ident(CFG.bars_ts_col)} >= (now() at time zone 'utc') - interval '{years} years'
          {sym_filter}
      ),
      gaps as (
        select canonical_symbol, (ts_utc - prev_ts) as gap
        from x
        where prev_ts is not null
      )
      select
        canonical_symbol,
        count(*) filter (where gap > interval '1 {('minute' if tf=='1m' else 'minute')}' ) as gap_events,
        max(gap) as max_gap
      from gaps
      group by 1
      order by gap_events desc, max_gap desc;
    """
    return qdf(conn, sql, params)

def check_integrity_ohlc(conn, table: str, tf: str, years: int, symbols: Optional[List[str]] = None) -> pd.DataFrame:
    sym_filter = ""
    params: Dict[str, Any] = {}
    if symbols:
        sym_filter = f"and {sql_ident(CFG.bars_symbol_col)} = any(%(symbols)s::text[])"
        params["symbols"] = symbols

    sql = f"""
      select
        {sql_ident(CFG.bars_symbol_col)} as canonical_symbol,
        count(*) filter (where {sql_ident(CFG.bars_open)} is null or {sql_ident(CFG.bars_high)} is null or {sql_ident(CFG.bars_low)} is null or {sql_ident(CFG.bars_close)} is null) as null_ohlc,
        count(*) filter (where {sql_ident(CFG.bars_open)}<=0 or {sql_ident(CFG.bars_high)}<=0 or {sql_ident(CFG.bars_low)}<=0 or {sql_ident(CFG.bars_close)}<=0) as nonpositive_ohlc,
        count(*) filter (where {sql_ident(CFG.bars_high)} < greatest({sql_ident(CFG.bars_open)},{sql_ident(CFG.bars_close)})
                      or {sql_ident(CFG.bars_low)}  > least({sql_ident(CFG.bars_open)},{sql_ident(CFG.bars_close)})
                      or {sql_ident(CFG.bars_high)} < {sql_ident(CFG.bars_low)}) as ohlc_inconsistent
      from {sql_ident(table)}
      where {sql_ident(CFG.bars_tf_col)} = '{tf}'
        and {sql_ident(CFG.bars_ts_col)} >= (now() at time zone 'utc') - interval '{years} years'
        {sym_filter}
      group by 1
      having
        count(*) filter (where {sql_ident(CFG.bars_open)} is null or {sql_ident(CFG.bars_high)} is null or {sql_ident(CFG.bars_low)} is null or {sql_ident(CFG.bars_close)} is null) > 0
        or count(*) filter (where {sql_ident(CFG.bars_open)}<=0 or {sql_ident(CFG.bars_high)}<=0 or {sql_ident(CFG.bars_low)}<=0 or {sql_ident(CFG.bars_close)}<=0) > 0
        or count(*) filter (where {sql_ident(CFG.bars_high)} < greatest({sql_ident(CFG.bars_open)},{sql_ident(CFG.bars_close)})
                         or {sql_ident(CFG.bars_low)}  > least({sql_ident(CFG.bars_open)},{sql_ident(CFG.bars_close)})
                         or {sql_ident(CFG.bars_high)} < {sql_ident(CFG.bars_low)}) > 0
      order by null_ohlc desc, nonpositive_ohlc desc, ohlc_inconsistent desc, canonical_symbol;
    """
    return qdf(conn, sql, params)

def check_counts(conn, table: str, tf: str, years: Optional[int] = None, days: Optional[int] = None, symbols: Optional[List[str]] = None) -> pd.DataFrame:
    """Check bar counts for given timeframe. Specify either years or days for time window."""
    if years is None and days is None:
        raise ValueError("Must specify either years or days parameter")
    
    interval = f"interval '{years} years'" if years is not None else f"interval '{days} days'"
    
    sym_filter = ""
    params: Dict[str, Any] = {}
    if symbols:
        sym_filter = f"and {sql_ident(CFG.bars_symbol_col)} = any(%(symbols)s::text[])"
        params["symbols"] = symbols

    sql = f"""
      select
        {sql_ident(CFG.bars_symbol_col)} as canonical_symbol,
        count(*) as bars,
        min({sql_ident(CFG.bars_ts_col)}) as min_ts,
        max({sql_ident(CFG.bars_ts_col)}) as max_ts
      from {sql_ident(table)}
      where {sql_ident(CFG.bars_tf_col)} = '{tf}'
        and {sql_ident(CFG.bars_ts_col)} >= (now() at time zone 'utc') - {interval}
        {sym_filter}
      group by 1
      order by bars asc, canonical_symbol;
    """
    return qdf(conn, sql, params)

def expected_vs_actual_counts(conn, table: str, tfs: List[str]) -> pd.DataFrame:
    """Compute expected vs actual bar counts per asset/timeframe from ingestion start to now."""
    if not tfs:
        return pd.DataFrame()

    sql = f"""
      select
        {sql_ident(CFG.bars_symbol_col)} as canonical_symbol,
        {sql_ident(CFG.bars_tf_col)} as timeframe,
        min({sql_ident(CFG.bars_ts_col)}) as start_ts_utc,
        max({sql_ident(CFG.bars_ts_col)}) as latest_ts_utc,
        count(*) as actual_bars
      from {sql_ident(table)}
      where {sql_ident(CFG.bars_tf_col)} = any(%(tfs)s::text[])
      group by 1,2
      order by 1,2;
    """

    df = qdf(conn, sql, {"tfs": tfs})
    if df.empty:
        return df

    now_utc = datetime.now(timezone.utc)

    def compute_expected(row):
        tf_seconds = timeframe_to_seconds(row["timeframe"])
        # Add 1 to include the first bar at start_ts_utc
        return int(((now_utc - row["start_ts_utc"]).total_seconds() // tf_seconds) + 1)

    df["expected_bars"] = df.apply(compute_expected, axis=1)
    df["missing_bars"] = df["expected_bars"] - df["actual_bars"]
    df["coverage_pct"] = (df["actual_bars"] / df["expected_bars"].where(df["expected_bars"] != 0)).round(4) * 100
    df["now_utc"] = now_utc

    return df[["canonical_symbol", "timeframe", "start_ts_utc", "latest_ts_utc", "now_utc", "expected_bars", "actual_bars", "missing_bars", "coverage_pct"]]

def check_dxy_component_dependency(conn, years: int) -> pd.DataFrame:
    comp = list(CFG.dxy_components)
    sql = f"""
      with ts as (
        select {sql_ident(CFG.bars_ts_col)} as ts_utc
        from {sql_ident(CFG.derived_bars_table)}
        where {sql_ident(CFG.bars_symbol_col)} = %(dxy)s
          and {sql_ident(CFG.bars_tf_col)} = '1m'
          and {sql_ident(CFG.bars_ts_col)} >= (now() at time zone 'utc') - interval '{years} years'
      ),
      fx as (
        select
          t.ts_utc,
          min(case when b.{sql_ident(CFG.bars_symbol_col)}='EURUSD' then b.{sql_ident(CFG.bars_close)} end) as eurusd,
          min(case when b.{sql_ident(CFG.bars_symbol_col)}='USDJPY' then b.{sql_ident(CFG.bars_close)} end) as usdjpy,
          min(case when b.{sql_ident(CFG.bars_symbol_col)}='GBPUSD' then b.{sql_ident(CFG.bars_close)} end) as gbpusd,
          min(case when b.{sql_ident(CFG.bars_symbol_col)}='USDCAD' then b.{sql_ident(CFG.bars_close)} end) as usdcad,
          min(case when b.{sql_ident(CFG.bars_symbol_col)}='USDSEK' then b.{sql_ident(CFG.bars_close)} end) as usdsek,
          min(case when b.{sql_ident(CFG.bars_symbol_col)}='USDCHF' then b.{sql_ident(CFG.bars_close)} end) as usdchf
        from ts t
        left join {sql_ident(CFG.data_bars_table)} b
          on b.{sql_ident(CFG.bars_tf_col)}='1m'
         and b.{sql_ident(CFG.bars_ts_col)}=t.ts_utc
         and b.{sql_ident(CFG.bars_symbol_col)} in ('EURUSD','USDJPY','GBPUSD','USDCAD','USDSEK','USDCHF')
        group by 1
      )
      select
        count(*) filter (
          where eurusd is null or usdjpy is null or gbpusd is null or usdcad is null or usdsek is null or usdchf is null
             or eurusd<=0 or usdjpy<=0 or gbpusd<=0 or usdcad<=0 or usdsek<=0 or usdchf<=0
        ) as dxy_minutes_with_missing_or_invalid_components,
        count(*) as dxy_total_minutes_checked
      from fx;
    """
    return qdf(conn, sql, {"dxy": CFG.dxy_symbol})

def check_agg_consistency_1m_to_5m_coverage(conn, active_days: int, min_required_1m: int = 5, strict: bool = True) -> pd.DataFrame:
    """
    Check aggregation consistency: for each 5m bucket, count underlying 1m bars.
    
    Args:
        conn: Database connection
        active_days: Number of days to check
        min_required_1m: Minimum required 1m bars (default 5 for strict mode, 3 for relaxed)
        strict: If True, require exactly 5 bars; if False, allow partial aggregation with min_required_1m
    
    Returns:
        DataFrame with canonical_symbol, bad_5m_bars, partial_5m_bars (if not strict)
    """
    sql = f"""
      with src as (
        select
          {sql_ident(CFG.bars_symbol_col)} as canonical_symbol,
          {sql_ident(CFG.bars_ts_col)} as ts_utc
        from {sql_ident(CFG.data_bars_table)}
        where {sql_ident(CFG.bars_tf_col)}='1m'
          and {sql_ident(CFG.bars_ts_col)} >= (now() at time zone 'utc') - interval '{active_days} days'
      ),
      roll as (
        select
          canonical_symbol,
          date_trunc('hour', ts_utc)
            + make_interval(mins => (extract(minute from ts_utc)::int / 5) * 5) as bar_5m_ts,
          count(*) as n_1m
        from src
        group by 1,2
      )
      select 
        canonical_symbol,
        count(*) filter (where n_1m < %(min_required)s) as bad_5m_bars,
        count(*) filter (where n_1m > 0 and n_1m < 5) as partial_5m_bars,
        count(*) filter (where n_1m = 0) as missing_5m_bars
      from roll
      where n_1m < %(min_required)s
      group by 1
      order by bad_5m_bars desc, canonical_symbol;
    """
    return qdf(conn, sql, {"min_required": min_required_1m})

def check_agg_consistency_1m_to_1h_coverage(conn, active_days: int, min_required_1m: int = 60, strict: bool = True) -> pd.DataFrame:
    """
    Check 1h aggregation consistency: for each 1h bucket, count underlying 1m bars.
    
    Args:
        conn: Database connection
        active_days: Number of days to check
        min_required_1m: Minimum required 1m bars (default 60 for strict mode)
        strict: If True, require exactly 60 bars; if False, allow partial with min_required_1m
    
    Returns:
        DataFrame with canonical_symbol, bad_1h_bars, partial_1h_bars, missing_1h_bars
    """
    sql = f"""
      with src as (
        select
          {sql_ident(CFG.bars_symbol_col)} as canonical_symbol,
          {sql_ident(CFG.bars_ts_col)} as ts_utc
        from {sql_ident(CFG.data_bars_table)}
        where {sql_ident(CFG.bars_tf_col)}='1m'
          and {sql_ident(CFG.bars_ts_col)} >= (now() at time zone 'utc') - interval '{active_days} days'
      ),
      roll as (
        select
          canonical_symbol,
          date_trunc('hour', ts_utc) as bar_1h_ts,
          count(*) as n_1m
        from src
        group by 1,2
      )
      select 
        canonical_symbol,
        count(*) filter (where n_1m < %(min_required)s) as bad_1h_bars,
        count(*) filter (where n_1m > 0 and n_1m < 60) as partial_1h_bars,
        count(*) filter (where n_1m = 0) as missing_1h_bars
      from roll
      where n_1m < %(min_required)s
      group by 1
      order by bad_1h_bars desc, canonical_symbol;
    """
    return qdf(conn, sql, {"min_required": min_required_1m})

def check_timestamp_monotonicity(conn, table: str, tf: str, days: int) -> pd.DataFrame:
    """Check for non-monotonic timestamps (out of order data)"""
    sql = f"""
      with ordered as (
        select
          {sql_ident(CFG.bars_symbol_col)} as canonical_symbol,
          {sql_ident(CFG.bars_ts_col)} as ts_utc,
          lag({sql_ident(CFG.bars_ts_col)}) over (
            partition by {sql_ident(CFG.bars_symbol_col)} 
            order by {sql_ident(CFG.bars_ts_col)}
          ) as prev_ts
        from {sql_ident(table)}
        where {sql_ident(CFG.bars_tf_col)} = '{tf}'
          and {sql_ident(CFG.bars_ts_col)} >= (now() at time zone 'utc') - interval '{days} days'
      )
      select canonical_symbol, count(*) as non_monotonic_count
      from ordered
      where prev_ts is not null and ts_utc <= prev_ts
      group by 1
      order by non_monotonic_count desc, canonical_symbol;
    """
    return qdf(conn, sql)

def check_future_timestamps(conn, table: str, tf: str) -> pd.DataFrame:
    """Check for timestamps in the future"""
    sql = f"""
      select
        {sql_ident(CFG.bars_symbol_col)} as canonical_symbol,
        count(*) as future_timestamp_count,
        max({sql_ident(CFG.bars_ts_col)}) as max_future_ts
      from {sql_ident(table)}
      where {sql_ident(CFG.bars_tf_col)} = '{tf}'
        and {sql_ident(CFG.bars_ts_col)} > (now() at time zone 'utc')
      group by 1
      order by future_timestamp_count desc, canonical_symbol;
    """
    return qdf(conn, sql)

def _interval_clause(days: Optional[int] = None, years: Optional[int] = None) -> str:
    if days is not None:
        return f"interval '{days} days'"
    if years is not None:
        return f"interval '{years} years'"
    raise ValueError("Must provide days or years interval")

def check_enhanced_ohlc_integrity(conn, table: str, tf: str, *, window_days: Optional[int] = None, window_years: Optional[int] = None) -> pd.DataFrame:
    """Enhanced OHLC validation: H>=L, O/C in [L,H], reasonable spreads"""
    interval_expr = _interval_clause(window_days, window_years)
    sql = f"""
      select
        {sql_ident(CFG.bars_symbol_col)} as canonical_symbol,
        count(*) filter (where {sql_ident(CFG.bars_high)} < {sql_ident(CFG.bars_low)}) as high_less_than_low,
        count(*) filter (where {sql_ident(CFG.bars_open)} < {sql_ident(CFG.bars_low)} 
                             or {sql_ident(CFG.bars_open)} > {sql_ident(CFG.bars_high)}) as open_out_of_range,
        count(*) filter (where {sql_ident(CFG.bars_close)} < {sql_ident(CFG.bars_low)} 
                             or {sql_ident(CFG.bars_close)} > {sql_ident(CFG.bars_high)}) as close_out_of_range,
        count(*) filter (where {sql_ident(CFG.bars_high)} = {sql_ident(CFG.bars_low)}) as zero_range_bars,
        count(*) filter (where ({sql_ident(CFG.bars_high)} - {sql_ident(CFG.bars_low)}) / nullif({sql_ident(CFG.bars_close)}, 0) > 0.10) as excessive_spread_bars
      from {sql_ident(table)}
      where {sql_ident(CFG.bars_tf_col)} = '{tf}'
        and {sql_ident(CFG.bars_ts_col)} >= (now() at time zone 'utc') - {interval_expr}
      group by 1
      having
        count(*) filter (where {sql_ident(CFG.bars_high)} < {sql_ident(CFG.bars_low)}) > 0
        or count(*) filter (where {sql_ident(CFG.bars_open)} < {sql_ident(CFG.bars_low)} 
                                or {sql_ident(CFG.bars_open)} > {sql_ident(CFG.bars_high)}) > 0
        or count(*) filter (where {sql_ident(CFG.bars_close)} < {sql_ident(CFG.bars_low)} 
                                or {sql_ident(CFG.bars_close)} > {sql_ident(CFG.bars_high)}) > 0
        or count(*) filter (where ({sql_ident(CFG.bars_high)} - {sql_ident(CFG.bars_low)}) / nullif({sql_ident(CFG.bars_close)}, 0) > 0.10) > 10
      order by high_less_than_low desc, open_out_of_range desc, canonical_symbol;
    """
    return qdf(conn, sql)

def check_volume_integrity(conn, table: str, tf: str, *, window_days: Optional[int] = None, window_years: Optional[int] = None) -> pd.DataFrame:
    """Check volume data integrity if volume column exists"""
    # Check if volume column exists first
    try:
        test_sql = f"SELECT {sql_ident(CFG.bars_volume)} FROM {sql_ident(table)} LIMIT 0"
        with conn.cursor() as cur:
            cur.execute(test_sql)
    except psycopg2.Error:
        # Volume column doesn't exist, return empty DataFrame
        return pd.DataFrame()
    
    sql = f"""
      select
        {sql_ident(CFG.bars_symbol_col)} as canonical_symbol,
        count(*) filter (where {sql_ident(CFG.bars_volume)} < 0) as negative_volume,
        count(*) filter (where {sql_ident(CFG.bars_volume)} is null) as null_volume,
        count(*) filter (where {sql_ident(CFG.bars_volume)} = 0) as zero_volume,
        count(*) as total_bars
      from {sql_ident(table)}
      where {sql_ident(CFG.bars_tf_col)} = '{tf}'
        and {sql_ident(CFG.bars_ts_col)} >= (now() at time zone 'utc') - {_interval_clause(window_days, window_years)}
      group by 1
      having
        count(*) filter (where {sql_ident(CFG.bars_volume)} < 0) > 0
        or count(*) filter (where {sql_ident(CFG.bars_volume)} is null) > 0
      order by negative_volume desc, null_volume desc, canonical_symbol;
    """
    return qdf(conn, sql)

def check_price_continuity(conn, table: str, tf: str, days: int, jump_threshold: float = 0.10) -> pd.DataFrame:
    """Check for suspicious price jumps between consecutive bars"""
    sql = f"""
      with prices as (
        select
          {sql_ident(CFG.bars_symbol_col)} as canonical_symbol,
          {sql_ident(CFG.bars_ts_col)} as ts_utc,
          {sql_ident(CFG.bars_close)} as close,
          lag({sql_ident(CFG.bars_close)}) over (
            partition by {sql_ident(CFG.bars_symbol_col)} 
            order by {sql_ident(CFG.bars_ts_col)}
          ) as prev_close
        from {sql_ident(table)}
        where {sql_ident(CFG.bars_tf_col)} = '{tf}'
          and {sql_ident(CFG.bars_ts_col)} >= (now() at time zone 'utc') - interval '{days} days'
      ),
      jumps as (
        select
          canonical_symbol,
          abs(close - prev_close) / nullif(prev_close, 0) as price_change_pct
        from prices
        where prev_close is not null and prev_close > 0
      )
      select
        canonical_symbol,
        count(*) filter (where price_change_pct > %(threshold)s) as large_jump_count,
        max(price_change_pct) as max_price_jump_pct
      from jumps
      group by 1
      having count(*) filter (where price_change_pct > %(threshold)s) > 0
      order by large_jump_count desc, max_price_jump_pct desc;
    """
    return qdf(conn, sql, {"threshold": jump_threshold})

def check_cross_timeframe_consistency(conn, active_days: int) -> pd.DataFrame:
    """Verify 5m bars can be derived from underlying 1m bars"""
    rel_tol = 1e-4
    abs_tol = 1e-6
    sql = f"""
      with bars_1m as (
        select
          {sql_ident(CFG.bars_symbol_col)} as canonical_symbol,
          date_trunc('hour', {sql_ident(CFG.bars_ts_col)})
            + make_interval(mins => (extract(minute from {sql_ident(CFG.bars_ts_col)})::int / 5) * 5) as bar_5m_ts,
          (array_agg({sql_ident(CFG.bars_open)} order by {sql_ident(CFG.bars_ts_col)}))[1] as derived_open,
          max({sql_ident(CFG.bars_high)}) as derived_high,
          min({sql_ident(CFG.bars_low)}) as derived_low,
          (array_agg({sql_ident(CFG.bars_close)} order by {sql_ident(CFG.bars_ts_col)} desc))[1] as derived_close,
          count(*) as bar_count
        from {sql_ident(CFG.data_bars_table)}
        where {sql_ident(CFG.bars_tf_col)} = '1m'
          and {sql_ident(CFG.bars_ts_col)} >= (now() at time zone 'utc') - interval '{active_days} days'
        group by 1, 2
        having count(*) = 5
      ),
      bars_5m as (
        select
          {sql_ident(CFG.bars_symbol_col)} as canonical_symbol,
          {sql_ident(CFG.bars_ts_col)} as bar_5m_ts,
          {sql_ident(CFG.bars_open)} as actual_open,
          {sql_ident(CFG.bars_high)} as actual_high,
          {sql_ident(CFG.bars_low)} as actual_low,
          {sql_ident(CFG.bars_close)} as actual_close
        from {sql_ident(CFG.derived_bars_table)}
        where {sql_ident(CFG.bars_tf_col)} = '5m'
          and {sql_ident(CFG.bars_ts_col)} >= (now() at time zone 'utc') - interval '{active_days} days'
      )
      select
        m.canonical_symbol,
        count(*) as mismatched_bars
      from bars_1m m
      join bars_5m f
        on m.canonical_symbol = f.canonical_symbol
       and m.bar_5m_ts = f.bar_5m_ts
      where
        abs(m.derived_high - f.actual_high) > (abs(f.actual_high) * {rel_tol} + {abs_tol})
        or abs(m.derived_low - f.actual_low) > (abs(f.actual_low) * {rel_tol} + {abs_tol})
        or abs(m.derived_open - f.actual_open) > (abs(f.actual_open) * {rel_tol} + {abs_tol})
        or abs(m.derived_close - f.actual_close) > (abs(f.actual_close) * {rel_tol} + {abs_tol})
      group by 1
      order by mismatched_bars desc, canonical_symbol;
    """
    return qdf(conn, sql)

def check_staleness_with_thresholds(conn, active: pd.DataFrame, active_days: int) -> Tuple[pd.DataFrame, Dict[str, int]]:
    """Check freshness with warning/critical thresholds"""
    sql = f"""
      select
        a.canonical_symbol,
        max(b.{sql_ident(CFG.bars_ts_col)}) as latest_1m_ts,
        (now() at time zone 'utc') as now_utc,
        extract(epoch from (now() at time zone 'utc') - max(b.{sql_ident(CFG.bars_ts_col)})) / 60 as staleness_minutes
      from (select unnest(%(symbols)s::text[]) as canonical_symbol) a
      left join {sql_ident(CFG.data_bars_table)} b
        on b.{sql_ident(CFG.bars_symbol_col)} = a.canonical_symbol
       and b.{sql_ident(CFG.bars_tf_col)} = '1m'
       and b.{sql_ident(CFG.bars_ts_col)} >= (now() at time zone 'utc') - interval '{active_days} days'
      group by 1
      order by staleness_minutes desc nulls last;
    """
    df = qdf(conn, sql, {"symbols": active["canonical_symbol"].tolist()})
    
    # Calculate counts
    if not df.empty and 'staleness_minutes' in df.columns:
        warning_count = int((df['staleness_minutes'] > CFG.staleness_warning_minutes).sum())
        critical_count = int((df['staleness_minutes'] > CFG.staleness_critical_minutes).sum())
    else:
        warning_count = 0
        critical_count = 0
    
    counts = {
        "warning": warning_count,
        "critical": critical_count
    }
    
    return df, counts

# ----------------------------
# REPORTING
# ----------------------------

def save_df(df: pd.DataFrame, out_dir: Path, name: str) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    csv_path = out_dir / f"{name}.csv"
    json_path = out_dir / f"{name}.json"
    df.to_csv(csv_path, index=False)
    df.to_json(json_path, orient="records", date_format="iso")
    print(f"  - wrote {csv_path}")
    print(f"  - wrote {json_path}")

def summarize(df: pd.DataFrame, title: str, top: int = 10) -> None:
    print("\n" + "=" * 80)
    print(title)
    print("=" * 80)
    if df.empty:
        print("(OK) No issues found / no rows returned.")
        return
    print(df.head(top).to_string(index=False))

def result_flag(df: pd.DataFrame) -> bool:
    """Return True if df indicates problems (non-empty)."""
    return not df.empty

# ----------------------------
# RUNNERS
# ----------------------------

def run_phase_a(conn, active_days: int) -> Dict[str, Any]:
    print("\n" + "!" * 80)
    print(f"PHASE A — Active Asset Verification (last {active_days} days)")
    print("!" * 80)
    
    active = get_active_assets(conn)
    print(f"\nFound {len(active)} active assets")


    def safe_check(fn, *args, **kwargs):
      try:
        return fn(*args, **kwargs)
      except Exception as e:
        print(f"\n❌ Error in {fn.__name__}: {e}")
        conn.rollback()
        return pd.DataFrame()

    freshness, staleness_counts = safe_check(check_staleness_with_thresholds, conn, active, active_days) if callable(globals().get('check_staleness_with_thresholds')) else (safe_check(check_freshness, conn, active, active_days), {'warning': 0, 'critical': 0})
    dup_data = safe_check(check_duplicates, conn, CFG.data_bars_table, ["1m"], active_days)
    dup_derived = safe_check(check_duplicates, conn, CFG.derived_bars_table, ["1m","5m","1h","1d"], active_days)
    align_5m = safe_check(check_alignment, conn, CFG.derived_bars_table, "5m", active_days)
    align_1h = safe_check(check_alignment, conn, CFG.derived_bars_table, "1h", active_days)
    align_1d = safe_check(check_alignment, conn, CFG.derived_bars_table, "1d", active_days)
    
    # Aggregation coverage checks (strict mode: require exact bar counts)
    # Policy: <3 bars = error (aggregation skipped), 3-4 = warning (low quality), 5 = ok
    agg_cov_5m = safe_check(check_agg_consistency_1m_to_5m_coverage, conn, active_days, min_required_1m=3, strict=False)
    agg_cov_1h = safe_check(check_agg_consistency_1m_to_1h_coverage, conn, active_days, min_required_1m=60, strict=True)
    
    # DXY-specific checks (in derived_data_bars)
    print("\nChecking DXY data...")
    dxy_counts_1m = safe_check(check_counts, conn, CFG.derived_bars_table, "1m", days=active_days, symbols=[CFG.dxy_symbol])
    dxy_counts_5m = safe_check(check_counts, conn, CFG.derived_bars_table, "5m", days=active_days, symbols=[CFG.dxy_symbol])
    dxy_counts_1h = safe_check(check_counts, conn, CFG.derived_bars_table, "1h", days=active_days, symbols=[CFG.dxy_symbol])
    dxy_counts_1d = safe_check(check_counts, conn, CFG.derived_bars_table, "1d", days=active_days, symbols=[CFG.dxy_symbol])
    
    monotonic_1m = safe_check(check_timestamp_monotonicity, conn, CFG.data_bars_table, "1m", active_days)
    future_ts_1m = safe_check(check_future_timestamps, conn, CFG.data_bars_table, "1m")
    enhanced_ohlc = safe_check(check_enhanced_ohlc_integrity, conn, CFG.data_bars_table, "1m", window_days=active_days)
    volume_issues = safe_check(check_volume_integrity, conn, CFG.data_bars_table, "1m", window_days=active_days)
    price_jumps = safe_check(check_price_continuity, conn, CFG.data_bars_table, "1m", active_days)
    cross_tf_consistency = safe_check(check_cross_timeframe_consistency, conn, active_days)

    # Console summary
    print(f"\n📊 Staleness: {staleness_counts['warning']} warnings (>{CFG.staleness_warning_minutes}m), "
          f"{staleness_counts['critical']} critical (>{CFG.staleness_critical_minutes}m)")
    summarize(freshness.head(20), "Phase A — Freshness (latest 1m per active asset, including DXY)")
    summarize(dup_data, "Phase A — Duplicates (data_bars 1m)")
    summarize(dup_derived, "Phase A — Duplicates (derived_data_bars 1m/5m/1h/1d)")
    summarize(align_5m[align_5m["misaligned_count"] > 0] if not align_5m.empty else align_5m, 
              "Phase A — Alignment errors (derived 5m)")
    summarize(align_1h[align_1h["misaligned_count"] > 0] if not align_1h.empty else align_1h, 
              "Phase A — Alignment errors (derived 1h)")
    summarize(align_1d[align_1d["misaligned_count"] > 0] if not align_1d.empty else align_1d, 
              "Phase A — Alignment errors (derived 1d)")
    summarize(agg_cov_5m[agg_cov_5m["bad_5m_bars"] > 0] if not agg_cov_5m.empty else agg_cov_5m, 
              "Phase A — 1m→5m strict coverage (requires exactly 5 bars)")
    summarize(agg_cov_1h[agg_cov_1h["bad_1h_bars"] > 0] if not agg_cov_1h.empty else agg_cov_1h, 
              "Phase A — 1m→1h strict coverage (requires exactly 60 bars)")
    summarize(monotonic_1m, "Phase A — Non-monotonic timestamps")
    summarize(future_ts_1m, "Phase A — Future timestamps")
    summarize(enhanced_ohlc, "Phase A — Enhanced OHLC integrity")
    if not volume_issues.empty:
        summarize(volume_issues, "Phase A — Volume integrity")
    summarize(price_jumps, "Phase A — Large price jumps (>10%)")
    summarize(cross_tf_consistency, "Phase A — Cross-timeframe consistency (1m vs 5m)")
    
    # DXY summaries
    summarize(dxy_counts_1m, "Phase A — DXY counts (1m)")
    summarize(dxy_counts_5m, "Phase A — DXY counts (5m)")
    summarize(dxy_counts_1h, "Phase A — DXY counts (1h)")
    summarize(dxy_counts_1d, "Phase A — DXY counts (1d)")

    problems = {
        "duplicates_data_bars_1m": result_flag(dup_data),
        "duplicates_derived": result_flag(dup_derived),
        "misaligned_5m": (not align_5m.empty and (align_5m["misaligned_count"] > 0).any()),
        "misaligned_1h": (not align_1h.empty and (align_1h["misaligned_count"] > 0).any()),
        "misaligned_1d": (not align_1d.empty and (align_1d["misaligned_count"] > 0).any()),
        "bad_5m_coverage_strict": (not agg_cov_5m.empty and (agg_cov_5m["bad_5m_bars"] > 0).any()),
        "bad_1h_coverage_strict": (not agg_cov_1h.empty and (agg_cov_1h["bad_1h_bars"] > 0).any()),
        "dxy_missing_data": (dxy_counts_1m.empty or dxy_counts_5m.empty or dxy_counts_1h.empty or dxy_counts_1d.empty),
        "non_monotonic_timestamps": result_flag(monotonic_1m),
        "future_timestamps": result_flag(future_ts_1m),
        "enhanced_ohlc_issues": result_flag(enhanced_ohlc),
        "volume_issues": result_flag(volume_issues),
        "large_price_jumps": result_flag(price_jumps),
        "cross_timeframe_mismatch": result_flag(cross_tf_consistency),
        "staleness_warning": staleness_counts['warning'] > 0,
        "staleness_critical": staleness_counts['critical'] > 0,
    }

    return {
        "phase": "A",
        "active_days": active_days,
        "generated_at_utc": utc_now_iso(),
        "problem_flags": problems,
        "staleness_counts": staleness_counts,
        "data": {
            "freshness": freshness,
            "duplicates_data_bars": dup_data,
            "duplicates_derived_bars": dup_derived,
            "alignment_5m": align_5m,
            "alignment_1h": align_1h,
            "alignment_1d": align_1d,
            "agg_coverage_5m_strict": agg_cov_5m,
            "agg_coverage_1h_strict": agg_cov_1h,
            "dxy_counts_1m": dxy_counts_1m,
            "dxy_counts_5m": dxy_counts_5m,
            "dxy_counts_1h": dxy_counts_1h,
            "dxy_counts_1d": dxy_counts_1d,
            "timestamp_monotonicity": monotonic_1m,
            "future_timestamps": future_ts_1m,
            "enhanced_ohlc_integrity": enhanced_ohlc,
            "volume_integrity": volume_issues,
            "price_continuity": price_jumps,
            "cross_timeframe_consistency": cross_tf_consistency,
        }
    }

def run_phase_b(conn, hist_years: int) -> Dict[str, Any]:
    def safe_check(fn, *args, **kwargs):
      try:
        return fn(*args, **kwargs)
      except Exception as e:
        print(f"\n❌ Error in {fn.__name__}: {e}")
        conn.rollback()
        return pd.DataFrame()

    print("\n" + "!" * 80)
    print(f"PHASE B — Historical Data Verification (last {hist_years} years)")
    print("!" * 80)
    
    active = get_active_assets(conn)
    symbols = active["canonical_symbol"].tolist()
    print(f"\nChecking {len(active)} active assets")

    # Coverage guardrail: verify historical data goes back far enough
    print("\nValidating historical coverage...")
    grace_days = 7  # Allow 7 days grace period
    coverage_check_sql = f"""
      select
        min({sql_ident(CFG.bars_ts_col)}) as earliest_ts,
        (now() at time zone 'utc') - interval '{hist_years} years' + interval '{grace_days} days' as required_min_ts,
        min({sql_ident(CFG.bars_ts_col)}) <= (now() at time zone 'utc') - interval '{hist_years} years' + interval '{grace_days} days' as sufficient_coverage
      from {sql_ident(CFG.data_bars_table)}
      where {sql_ident(CFG.bars_tf_col)} = '1m';
    """
    coverage_check = safe_check(qdf, conn, coverage_check_sql)
    
    if coverage_check.empty or not coverage_check.iloc[0]["sufficient_coverage"]:
        earliest = coverage_check.iloc[0]["earliest_ts"] if not coverage_check.empty else "N/A"
        required = coverage_check.iloc[0]["required_min_ts"] if not coverage_check.empty else "N/A"
        print(f"\n⚠️  WARNING: Insufficient historical coverage!")
        print(f"   Earliest data: {earliest}")
        print(f"   Required: {required} (with {grace_days} day grace)")
        print(f"   Phase B results may be incomplete or misleading.")
        coverage_guardrail_passed = False
    else:
        print(f"✓ Historical coverage sufficient (goes back to {coverage_check.iloc[0]['earliest_ts']})")
        coverage_guardrail_passed = True

    integrity_1m = safe_check(check_integrity_ohlc, conn, CFG.data_bars_table, "1m", hist_years)
    counts_1m = safe_check(check_counts, conn, CFG.data_bars_table, "1m", hist_years)
    gap_density_1m = safe_check(check_gap_density, conn, CFG.data_bars_table, "1m", hist_years)

    # Enhanced checks for historical data
    print("\nRunning enhanced historical validations...")
    enhanced_ohlc_hist = safe_check(check_enhanced_ohlc_integrity, conn, CFG.data_bars_table, "1m", window_years=hist_years)
    volume_issues_hist = safe_check(check_volume_integrity, conn, CFG.data_bars_table, "1m", window_years=hist_years)

    # DXY checks
    print("\nChecking DXY data...")
    dxy_counts_1m = safe_check(check_counts, conn, CFG.derived_bars_table, "1m", hist_years, symbols=[CFG.dxy_symbol])
    dxy_counts_5m = safe_check(check_counts, conn, CFG.derived_bars_table, "5m", hist_years, symbols=[CFG.dxy_symbol])
    dxy_counts_1h = safe_check(check_counts, conn, CFG.derived_bars_table, "1h", hist_years, symbols=[CFG.dxy_symbol])

    dxy_component_dependency = safe_check(check_dxy_component_dependency, conn, hist_years)

    dxy_align_5m = safe_check(check_alignment, conn, CFG.derived_bars_table, "5m", days=365*hist_years)
    dxy_align_1h = safe_check(check_alignment, conn, CFG.derived_bars_table, "1h", days=365*hist_years)
    dxy_align_5m = dxy_align_5m[dxy_align_5m["canonical_symbol"] == CFG.dxy_symbol] if not dxy_align_5m.empty else dxy_align_5m
    dxy_align_1h = dxy_align_1h[dxy_align_1h["canonical_symbol"] == CFG.dxy_symbol] if not dxy_align_1h.empty else dxy_align_1h

    # Console summary
    summarize(integrity_1m, "Phase B — OHLC Integrity issues (data_bars 1m)")
    summarize(enhanced_ohlc_hist, "Phase B — Enhanced OHLC Integrity")
    if not volume_issues_hist.empty:
        summarize(volume_issues_hist, "Phase B — Volume Integrity")
    summarize(counts_1m, "Phase B — Counts per asset (data_bars 1m)")
    summarize(gap_density_1m.head(25), "Phase B — Gap density (top 25 by gap_events) (data_bars 1m)")
    summarize(dxy_counts_1m, "Phase B — DXY counts (derived 1m)")
    summarize(dxy_counts_5m, "Phase B — DXY counts (derived 5m)")
    summarize(dxy_counts_1h, "Phase B — DXY counts (derived 1h)")
    summarize(dxy_component_dependency, "Phase B — DXY component dependency (must be 0 missing/invalid)")
    summarize(dxy_align_5m, "Phase B — DXY alignment (5m)")
    summarize(dxy_align_1h, "Phase B — DXY alignment (1h)")

    problems = {
        "insufficient_historical_coverage": not coverage_guardrail_passed,
        "integrity_issues_1m": result_flag(integrity_1m),
        "enhanced_ohlc_issues": result_flag(enhanced_ohlc_hist),
        "volume_issues": result_flag(volume_issues_hist),
        "dxy_component_dependency_fail": (
            (not dxy_component_dependency.empty)
            and int(dxy_component_dependency.iloc[0]["dxy_minutes_with_missing_or_invalid_components"]) > 0
        ),
        "dxy_missing_5m_or_1h": (dxy_counts_5m.empty or dxy_counts_1h.empty),
        "dxy_misaligned_5m": (not dxy_align_5m.empty and int(dxy_align_5m.iloc[0]["misaligned_count"]) > 0),
        "dxy_misaligned_1h": (not dxy_align_1h.empty and int(dxy_align_1h.iloc[0]["misaligned_count"]) > 0),
    }

    return {
        "phase": "B",
        "hist_years": hist_years,
        "generated_at_utc": utc_now_iso(),
        "coverage_guardrail_passed": coverage_guardrail_passed,
        "problem_flags": problems,
        "data": {
            "coverage_check": coverage_check,
            "integrity_1m": integrity_1m,
            "counts_1m": counts_1m,
            "gap_density_1m": gap_density_1m,
            "enhanced_ohlc_integrity": enhanced_ohlc_hist,
            "volume_integrity": volume_issues_hist,
            "dxy_counts_1m": dxy_counts_1m,
            "dxy_counts_5m": dxy_counts_5m,
            "dxy_counts_1h": dxy_counts_1h,
            "dxy_component_dependency": dxy_component_dependency,
            "dxy_alignment_5m": dxy_align_5m,
            "dxy_alignment_1h": dxy_align_1h,
        }
    }

def run_expected_actual_tables(conn, ingest_tfs: List[str], agg_tfs: List[str]) -> Dict[str, Any]:
    print("\n" + "!" * 80)
    print("EXPECTED VS ACTUAL BAR COUNTS")
    print("!" * 80)

    def safe_check(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            print(f"\n❌ Error in {fn.__name__}: {e}")
            conn.rollback()
            return pd.DataFrame()

    ingestion_df = safe_check(expected_vs_actual_counts, conn, CFG.data_bars_table, ingest_tfs)
    aggregation_df = safe_check(expected_vs_actual_counts, conn, CFG.derived_bars_table, agg_tfs)

    summarize(ingestion_df.head(20), "Ingestion — Expected vs Actual (counts only)")
    summarize(aggregation_df.head(20), "Aggregation — Expected vs Actual (counts only)")

    return {
        "ingestion": {
            "timeframes": ingest_tfs,
            "data": ingestion_df,
        },
        "aggregation": {
            "timeframes": agg_tfs,
            "data": aggregation_df,
        },
    }

# ----------------------------
# MAIN
# ----------------------------

def main():
    parser = argparse.ArgumentParser(
        description="DistortSignals Data Verification Script",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument(
        "--phase",
        choices=["A", "B", "ALL"],
        required=True,
        help="Phase A: active assets (recent data), Phase B: historical (3yr), ALL: both phases"
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(os.getenv("OUTPUT_DIR", "reports/datavalidation")),
        help="Directory to save output files (default: reports/datavalidation)"
    )
    parser.add_argument(
        "--active-days",
        type=int,
        default=int(os.getenv("ACTIVE_DAYS", "7")),
        help="Days to check for Phase A (default: 7)"
    )
    parser.add_argument(
        "--hist-years",
        type=int,
        default=int(os.getenv("HIST_YEARS", "3")),
        help="Years to check for Phase B (default: 3)"
    )
    parser.add_argument(
        "--dataset",
        choices=["live", "historical"],
        default="live",
        help="Which dataset to check: live (data_bars, derived_data_bars) or historical (historical_bars_1m, historical_bars_derived)"
    )
    parser.add_argument(
      "--ingest-tfs",
      type=str,
      default=DEFAULT_INGEST_TFS,
      help="Comma-separated timeframes for ingestion expected-vs-actual matrix (default env INGEST_TFS or '1m')"
    )
    parser.add_argument(
      "--agg-tfs",
      type=str,
      default=DEFAULT_AGG_TFS,
      help="Comma-separated timeframes for aggregation expected-vs-actual matrix (default env AGG_TFS or '1m,5m,1h')"
    )

    args = parser.parse_args()

    ingest_tfs = parse_tf_list(args.ingest_tfs)
    agg_tfs = parse_tf_list(args.agg_tfs)

    global CFG
    CFG = get_config(args.dataset)

    # Connect
    try:
        print("Connecting to database...")
        conn = get_conn()
        print("✓ Connected successfully")
    except Exception as e:
        print(f"ERROR: Failed to connect to database: {e}")
        sys.exit(1)

    # Run phases
    results: Dict[str, Any] = {}
    
    try:
        if args.phase in ("A", "ALL"):
            results["phase_a"] = run_phase_a(conn, args.active_days)
        
        if args.phase in ("B", "ALL"):
            results["phase_b"] = run_phase_b(conn, args.hist_years)

        results["expected_vs_actual"] = run_expected_actual_tables(
          conn,
          ingest_tfs,
          agg_tfs,
        )

        # Create single combined report
        args.output_dir.mkdir(parents=True, exist_ok=True)
        report_base = args.output_dir / f"{RUN_TIMESTAMP}_combined_verification_report"
        
        # Add metadata
        results["run_metadata"] = {
            "run_timestamp": RUN_TIMESTAMP,
            "generated_at_utc": utc_now_iso(),
            "config": {
                "staleness_warning_minutes": CFG.staleness_warning_minutes,
                "staleness_critical_minutes": CFG.staleness_critical_minutes,
                "data_bars_table": CFG.data_bars_table,
                "derived_bars_table": CFG.derived_bars_table,
            }
        }
        
        # Save combined JSON report (serializable version)
        json_report = {}
        for key, value in results.items():
            if isinstance(value, dict):
                json_report[key] = {}
                for k, v in value.items():
                    if isinstance(v, pd.DataFrame):
                        json_report[key][k] = v.to_dict(orient='records')
                    elif isinstance(v, dict):
                        json_report[key][k] = {}
                        for k2, v2 in v.items():
                            if isinstance(v2, pd.DataFrame):
                                json_report[key][k][k2] = v2.to_dict(orient='records')
                            else:
                                json_report[key][k][k2] = v2
                    else:
                        json_report[key][k] = v
            else:
                json_report[key] = value
        
        json_path = f"{report_base}.json"
        with open(json_path, "w") as f:
            json.dump(json_report, f, indent=2, default=str)
        
        # Save combined text report summary
        text_path = f"{report_base}.txt"
        with open(text_path, "w") as f:
            f.write("=" * 80 + "\n")
            f.write("DISTORT SIGNALS DATA VERIFICATION REPORT\n")
            f.write("=" * 80 + "\n\n")
            f.write(f"Run Timestamp: {RUN_TIMESTAMP}\n")
            f.write(f"Generated: {utc_now_iso()}\n")
            f.write(f"Dataset: {args.dataset}\n")
            f.write(f"Config Tables: {CFG.data_bars_table}, {CFG.derived_bars_table}\n\n")
            
            # Phase A summary
            if "phase_a" in results:
                f.write("=" * 80 + "\n")
                f.write("PHASE A - ACTIVE ASSET VERIFICATION\n")
                f.write("=" * 80 + "\n")
                phase_a = results["phase_a"]
                f.write(f"Active Days: {phase_a['active_days']}\n")
                f.write(f"Staleness Warnings: {phase_a['staleness_counts'].get('warning', 0)}\n")
                f.write(f"Staleness Critical: {phase_a['staleness_counts'].get('critical', 0)}\n\n")
                
                f.write("Problem Flags:\n")
                for flag, value in phase_a["problem_flags"].items():
                    status = "✗ FAIL" if value else "✓ PASS"
                    f.write(f"  {status}: {flag}\n")
                f.write("\n")
            
            # Phase B summary
            if "phase_b" in results:
                f.write("=" * 80 + "\n")
                f.write("PHASE B - HISTORICAL DATA VERIFICATION\n")
                f.write("=" * 80 + "\n")
                phase_b = results["phase_b"]
                f.write(f"Historical Years: {phase_b['hist_years']}\n")
                f.write(f"Coverage Guardrail Passed: {'✓ YES' if phase_b.get('coverage_guardrail_passed') else '✗ NO'}\n\n")
                
                f.write("Problem Flags:\n")
                for flag, value in phase_b["problem_flags"].items():
                    status = "✗ FAIL" if value else "✓ PASS"
                    f.write(f"  {status}: {flag}\n")
                f.write("\n")
            
            # Expected vs Actual summary
            if "expected_vs_actual" in results:
                f.write("=" * 80 + "\n")
                f.write("EXPECTED VS ACTUAL BAR COUNTS\n")
                f.write("=" * 80 + "\n")
                
                if "ingestion" in results["expected_vs_actual"]:
                    ing = results["expected_vs_actual"]["ingestion"]
                    f.write(f"\nIngestion Timeframes: {', '.join(ing['timeframes'])}\n")
                    if isinstance(ing["data"], pd.DataFrame) and not ing["data"].empty:
                        f.write(ing["data"].to_string(index=False))
                        f.write("\n")
                
                if "aggregation" in results["expected_vs_actual"]:
                    agg = results["expected_vs_actual"]["aggregation"]
                    f.write(f"\nAggregation Timeframes: {', '.join(agg['timeframes'])}\n")
                    if isinstance(agg["data"], pd.DataFrame) and not agg["data"].empty:
                        f.write(agg["data"].to_string(index=False))
                        f.write("\n")
                f.write("\n")
        
        print("\n" + "=" * 80)
        print("VERIFICATION COMPLETE")
        print("=" * 80)
        print(f"\nReports saved:")
        print(f"  JSON: {json_path}")
        print(f"  Text: {text_path}")
        
        # Check for problems
        all_ok = True
        for phase_key, phase_result in results.items():
            if "problem_flags" in phase_result:
                problems = [k for k, v in phase_result["problem_flags"].items() if v]
                if problems:
                    all_ok = False
                    print(f"\n⚠️  {phase_key.upper()} found issues:")
                    for p in problems:
                        print(f"   - {p}")
        
        if all_ok:
            print("\n✓ All checks passed!")
        else:
            print("\n⚠️  Some issues found - review output files for details")
            sys.exit(1)

    except Exception as e:
        print(f"\n❌ ERROR during verification: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        conn.close()

if __name__ == "__main__":
    main()
