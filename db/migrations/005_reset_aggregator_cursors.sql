-- Reset aggregator cursors to valid positions based on available source data
-- This positions cursors at (max_boundary - interval), allowing the last complete
-- window to be re-aggregated safely via upsert
--
-- CRITICAL: DXY 1m candles are in derived_data_bars (synthetic), not data_bars

BEGIN;

-- For 5m aggregation (from 1m source)
-- Note: DXY 1m is in derived_data_bars, not data_bars
WITH max_1m AS (
  SELECT canonical_symbol, MAX(ts_utc) as max_ts
  FROM (
    SELECT canonical_symbol, ts_utc FROM data_bars WHERE timeframe='1m'
    UNION ALL
    SELECT canonical_symbol, ts_utc FROM derived_data_bars WHERE timeframe='1m' AND deleted_at IS NULL
  ) x
  GROUP BY canonical_symbol
)
UPDATE data_agg_state s
SET 
  last_agg_bar_ts_utc = (
    -- Floor to 5m boundary and subtract one interval
    to_timestamp(
      (floor(extract(epoch from m.max_ts) / 300) * 300 - 300)
    )
  ),
  status = 'idle',
  next_run_at = NOW(),
  last_error = 'cursor_reset_2026-01-11',
  updated_at = NOW()
FROM max_1m m
WHERE s.canonical_symbol = m.canonical_symbol
  AND s.timeframe = '5m'
  AND s.source_timeframe = '1m'
  AND (
    s.last_agg_bar_ts_utc IS NULL
    OR s.last_agg_bar_ts_utc >= m.max_ts
  );

-- For 1h aggregation (from 5m source)
WITH max_5m AS (
  SELECT canonical_symbol, MAX(ts_utc) as max_ts
  FROM derived_data_bars 
  WHERE timeframe='5m' AND deleted_at IS NULL
  GROUP BY canonical_symbol
)
UPDATE data_agg_state s
SET 
  last_agg_bar_ts_utc = (
    -- Floor to 1h boundary and subtract one interval
    to_timestamp(
      (floor(extract(epoch from m.max_ts) / 3600) * 3600 - 3600)
    )
  ),
  status = 'idle',
  next_run_at = NOW(),
  last_error = 'cursor_reset_2026-01-11',
  updated_at = NOW()
FROM max_5m m
WHERE s.canonical_symbol = m.canonical_symbol
  AND s.timeframe = '1h'
  AND s.source_timeframe = '5m'
  AND (
    s.last_agg_bar_ts_utc IS NULL
    OR s.last_agg_bar_ts_utc >= m.max_ts
  );

-- Verify DXY cursor was set correctly (DXY source is derived only)
DO $$
DECLARE
  v_dxy_cursor timestamptz;
  v_dxy_max_source timestamptz;
BEGIN
  SELECT last_agg_bar_ts_utc INTO v_dxy_cursor
  FROM data_agg_state
  WHERE canonical_symbol = 'DXY' AND timeframe = '5m';
  
  SELECT MAX(ts_utc) INTO v_dxy_max_source
  FROM derived_data_bars
  WHERE canonical_symbol = 'DXY' AND timeframe = '1m' AND deleted_at IS NULL;
  
  IF v_dxy_cursor IS NULL OR v_dxy_max_source IS NULL THEN
    RAISE WARNING 'DXY cursor reset check: cursor=%, max_source=%', v_dxy_cursor, v_dxy_max_source;
  ELSIF v_dxy_cursor > v_dxy_max_source THEN
    RAISE EXCEPTION 'DXY cursor still ahead of source after reset: cursor=%, max_source=%', v_dxy_cursor, v_dxy_max_source;
  ELSE
    RAISE NOTICE 'DXY cursor reset successfully: cursor=%, max_source=%', v_dxy_cursor, v_dxy_max_source;
  END IF;
END $$;

-- Report on what was updated
DO $$
DECLARE
  v_updated_5m int;
  v_updated_1h int;
BEGIN
  SELECT COUNT(*) INTO v_updated_5m
  FROM data_agg_state
  WHERE timeframe = '5m' 
    AND last_error = 'cursor_reset_2026-01-11'
    AND updated_at >= NOW() - INTERVAL '1 minute';
  
  SELECT COUNT(*) INTO v_updated_1h
  FROM data_agg_state
  WHERE timeframe = '1h' 
    AND last_error = 'cursor_reset_2026-01-11'
    AND updated_at >= NOW() - INTERVAL '1 minute';
  
  RAISE NOTICE 'Cursor reset complete: 5m tasks=%, 1h tasks=%', v_updated_5m, v_updated_1h;
END $$;

-- Post-reset validation: Ensure NO cursors are ahead of source data
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM data_agg_state s
    JOIN (
      SELECT canonical_symbol, MAX(ts_utc) AS max_ts
      FROM (
        SELECT canonical_symbol, ts_utc FROM data_bars WHERE timeframe='1m'
        UNION ALL
        SELECT canonical_symbol, ts_utc FROM derived_data_bars WHERE timeframe='1m' AND deleted_at IS NULL
      ) x
      GROUP BY canonical_symbol
    ) m USING (canonical_symbol)
    WHERE s.timeframe='5m'
      AND s.last_agg_bar_ts_utc > m.max_ts
  ) THEN
    RAISE EXCEPTION 'Post-reset validation failed: 5m cursor still ahead of source';
  END IF;
  
  IF EXISTS (
    SELECT 1
    FROM data_agg_state s
    JOIN (
      SELECT canonical_symbol, MAX(ts_utc) AS max_ts
      FROM derived_data_bars 
      WHERE timeframe='5m' AND deleted_at IS NULL
      GROUP BY canonical_symbol
    ) m USING (canonical_symbol)
    WHERE s.timeframe='1h'
      AND s.last_agg_bar_ts_utc > m.max_ts
  ) THEN
    RAISE EXCEPTION 'Post-reset validation failed: 1h cursor still ahead of source';
  END IF;
  
  RAISE NOTICE 'Post-reset validation: All cursors within valid range';
END $$;

COMMIT;
