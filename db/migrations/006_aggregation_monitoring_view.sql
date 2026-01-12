-- Monitoring view for aggregation frontier health
-- This view helps detect cursor runaway and data pipeline issues

CREATE OR REPLACE VIEW v_aggregation_frontier_health AS
WITH source_1m AS (
  SELECT 
    canonical_symbol,
    MAX(ts_utc) AS max_ts
  FROM (
    SELECT canonical_symbol, ts_utc FROM data_bars WHERE timeframe='1m'
    UNION ALL
    SELECT canonical_symbol, ts_utc FROM derived_data_bars WHERE timeframe='1m' AND deleted_at IS NULL
  ) x
  GROUP BY canonical_symbol
),
source_5m AS (
  SELECT 
    canonical_symbol,
    MAX(ts_utc) AS max_ts
  FROM derived_data_bars 
  WHERE timeframe='5m' AND deleted_at IS NULL
  GROUP BY canonical_symbol
)
SELECT 
  s.canonical_symbol,
  s.timeframe,
  s.last_agg_bar_ts_utc AS cursor,
  CASE 
    WHEN s.timeframe = '5m' THEN src1.max_ts
    WHEN s.timeframe = '1h' THEN src5.max_ts
  END AS max_source_ts,
  CASE 
    WHEN s.timeframe = '5m' THEN s.last_agg_bar_ts_utc - src1.max_ts
    WHEN s.timeframe = '1h' THEN s.last_agg_bar_ts_utc - src5.max_ts
  END AS cursor_gap,
  CASE 
    WHEN s.timeframe = '5m' AND s.last_agg_bar_ts_utc > src1.max_ts THEN 'AHEAD'
    WHEN s.timeframe = '1h' AND s.last_agg_bar_ts_utc > src5.max_ts THEN 'AHEAD'
    WHEN s.last_agg_bar_ts_utc IS NULL THEN 'NULL'
    ELSE 'OK'
  END AS cursor_status,
  s.total_runs,
  s.total_bars_created,
  ROUND(s.total_bars_created::numeric / NULLIF(s.total_runs, 0), 4) AS bars_per_run,
  s.last_successful_at_utc,
  EXTRACT(EPOCH FROM (NOW() - s.last_successful_at_utc))/60 AS minutes_since_success,
  s.status,
  s.hard_fail_streak,
  s.last_error
FROM data_agg_state s
LEFT JOIN source_1m src1 ON s.canonical_symbol = src1.canonical_symbol AND s.timeframe = '5m'
LEFT JOIN source_5m src5 ON s.canonical_symbol = src5.canonical_symbol AND s.timeframe = '1h'
WHERE s.timeframe IN ('5m', '1h')
ORDER BY s.canonical_symbol, s.timeframe;

-- Grant permissions (authenticated can monitor, anon cannot)
REVOKE ALL ON v_aggregation_frontier_health FROM public;
REVOKE ALL ON v_aggregation_frontier_health FROM anon;
GRANT SELECT ON v_aggregation_frontier_health TO service_role;
GRANT SELECT ON v_aggregation_frontier_health TO authenticated;

-- Usage examples:
-- 
-- Check for cursor runaway:
-- SELECT * FROM v_aggregation_frontier_health WHERE cursor_status = 'AHEAD';
--
-- Check for stalled aggregation:
-- SELECT * FROM v_aggregation_frontier_health WHERE minutes_since_success > 60;
--
-- Check efficiency (should be > 0.01 after fix):
-- SELECT * FROM v_aggregation_frontier_health WHERE bars_per_run < 0.01;
