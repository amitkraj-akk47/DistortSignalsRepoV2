-- ============================================================================
-- Step 1A: Staleness Diagnostic Queries
-- ============================================================================
-- Run these to identify ingestion issues and cursor advancement problems
--
-- Usage: psql $PG_DSN -f diagnose_staleness.sql
-- ============================================================================

\echo '=== 1. Current Staleness by Asset ==='
SELECT 
    canonical_symbol,
    MAX(ts_utc) as latest_bar,
    NOW() AT TIME ZONE 'UTC' as now_utc,
    EXTRACT(EPOCH FROM (NOW() AT TIME ZONE 'UTC' - MAX(ts_utc))) / 60 as staleness_minutes
FROM data_bars
WHERE timeframe = '1m'
GROUP BY canonical_symbol
ORDER BY staleness_minutes DESC;

\echo ''
\echo '=== 2. Recent Ingestion Job Runs (Last 2 Hours) ==='
-- Note: Adjust table/column names if your job tracking differs
SELECT 
    job_name,
    status,
    started_at,
    completed_at,
    completed_at - started_at as duration,
    error_message,
    bars_inserted
FROM job_runs 
WHERE job_name LIKE '%ingest%'
  AND started_at >= NOW() - INTERVAL '2 hours'
ORDER BY started_at DESC
LIMIT 20;

\echo ''
\echo '=== 3. Ingestion Job Success Rate (Last 24 Hours) ==='
SELECT 
    job_name,
    COUNT(*) as total_runs,
    COUNT(*) FILTER (WHERE status = 'success') as successful,
    COUNT(*) FILTER (WHERE status = 'failed') as failed,
    ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'success') / COUNT(*), 2) as success_rate_pct,
    AVG(completed_at - started_at) as avg_duration,
    SUM(bars_inserted) as total_bars_inserted
FROM job_runs 
WHERE job_name LIKE '%ingest%'
  AND started_at >= NOW() - INTERVAL '24 hours'
GROUP BY job_name
ORDER BY job_name;

\echo ''
\echo '=== 4. Bars Inserted Per Hour (Last 24 Hours) ==='
SELECT 
    DATE_TRUNC('hour', ts_utc) as hour,
    canonical_symbol,
    COUNT(*) as bars_inserted
FROM data_bars
WHERE timeframe = '1m'
  AND ts_utc >= NOW() - INTERVAL '24 hours'
GROUP BY DATE_TRUNC('hour', ts_utc), canonical_symbol
ORDER BY hour DESC, canonical_symbol;

\echo ''
\echo '=== 5. Check for Gaps in Last 24 Hours (>5 min between bars) ==='
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
LIMIT 50;

\echo ''
\echo '=== 6. Cursor/State Table Check (if exists) ==='
-- Adjust based on your cursor tracking mechanism
SELECT 
    canonical_symbol,
    timeframe,
    last_processed_timestamp,
    NOW() AT TIME ZONE 'UTC' - last_processed_timestamp as cursor_staleness,
    updated_at
FROM ingestion_cursors
ORDER BY canonical_symbol, timeframe;

\echo ''
\echo '=== 7. Check for Stalled Cursors ==='
-- Cursors that haven't moved in 15+ minutes
SELECT 
    canonical_symbol,
    timeframe,
    last_processed_timestamp,
    EXTRACT(EPOCH FROM (NOW() AT TIME ZONE 'UTC' - last_processed_timestamp)) / 60 as minutes_stalled,
    updated_at
FROM ingestion_cursors
WHERE (NOW() AT TIME ZONE 'UTC' - last_processed_timestamp) > INTERVAL '15 minutes'
ORDER BY minutes_stalled DESC;

\echo ''
\echo '=== 8. Expected vs Actual Bars (Last Hour) ==='
-- Should have ~60 bars per asset for last hour (if markets open)
SELECT 
    canonical_symbol,
    COUNT(*) as bars_in_last_hour,
    60 - COUNT(*) as missing_bars
FROM data_bars
WHERE timeframe = '1m'
  AND ts_utc >= DATE_TRUNC('hour', NOW() AT TIME ZONE 'UTC')
GROUP BY canonical_symbol
ORDER BY missing_bars DESC;

\echo ''
\echo '=== Diagnostic Complete ==='
\echo 'Next steps:'
\echo '  1. If staleness > 10 min: Check Cloudflare Worker cron schedule'
\echo '  2. If job_runs shows failures: Review error_message column'
\echo '  3. If gaps detected: Check provider API logs and rate limits'
\echo '  4. If cursors stalled: Verify cursor update logic in ingestion code'
