-- DXY Migration - Phase 5: Update Aggregation Functions
-- Remove UNION ALL for 1m timeframe since DXY is now in data_bars
-- 
-- After this migration:
-- - 1m data: Only query data_bars (DXY now included there)
-- - 5m/1h data: Keep as-is (5m still only in derived_data_bars)

BEGIN;

-- ============================================================================
-- Update aggregate_1m_to_5m_window to remove UNION ALL for 1m source
-- ============================================================================

CREATE OR REPLACE FUNCTION aggregate_1m_to_5m_window(
  p_symbol text,
  p_from_utc timestamptz,
  p_to_utc timestamptz,
  p_derivation_version int DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cnt int;
  v_o double precision;
  v_c double precision;
  v_h double precision;
  v_l double precision;
  v_vol double precision;
  v_vwap double precision;
  v_tc int;
  v_q int;
BEGIN
  IF p_to_utc <= p_from_utc THEN
    RAISE EXCEPTION 'Invalid window';
  END IF;

  -- MIGRATION CHANGE: Removed UNION ALL, now only reads from data_bars
  -- DXY 1m is now in data_bars, not derived_data_bars
  WITH src AS (
    SELECT ts_utc, open, high, low, close, vol, vwap, trade_count
    FROM data_bars
    WHERE canonical_symbol = p_symbol
      AND timeframe = '1m'
      AND ts_utc >= p_from_utc
      AND ts_utc < p_to_utc
  ),
  ordered AS (
    SELECT * FROM src ORDER BY ts_utc ASC
  ),
  agg AS (
    SELECT
      count(*) cnt,
      (array_agg(open ORDER BY ts_utc ASC))[1] o,
      (array_agg(close ORDER BY ts_utc ASC))[count(*)] c,
      max(high) h,
      min(low) l,
      sum(coalesce(vol, 0)) vol_sum,
      CASE
        WHEN sum(coalesce(vol, 0)) > 0
        THEN sum(coalesce(vwap, 0) * coalesce(vol, 0)) / nullif(sum(coalesce(vol, 0)), 0)
        ELSE NULL
      END vwap_calc,
      sum(coalesce(trade_count, 0))::int tc_sum
    FROM ordered
  )
  SELECT cnt, o, c, h, l, vol_sum, vwap_calc, tc_sum
  INTO v_cnt, v_o, v_c, v_h, v_l, v_vol, v_vwap, v_tc
  FROM agg;

  -- Quality scoring (matching production logic)
  IF v_cnt >= 5 THEN
    v_q := 2;
  ELSIF v_cnt = 4 THEN
    v_q := 1;
  ELSIF v_cnt = 3 THEN
    v_q := 0;
  ELSE
    RETURN jsonb_build_object(
      'success', true,
      'stored', false,
      'reason', 'insufficient_source_bars',
      'source_count', v_cnt
    );
  END IF;

  PERFORM _upsert_derived_bar(
    p_symbol, '5m', p_from_utc, v_o, v_h, v_l, v_c, v_vol, v_vwap, v_tc,
    'agg', '1m', v_cnt, 5, v_q, p_derivation_version,
    jsonb_build_object('from', p_from_utc, 'to', p_to_utc, 'source', 'data_bars_only')
  );

  RETURN jsonb_build_object(
    'success', true,
    'stored', true,
    'source_count', v_cnt,
    'quality_score', v_q
  );
END;
$$;

-- ============================================================================
-- Update aggregate_5m_to_1h_window (keep UNION ALL for 5m source)
-- ============================================================================

CREATE OR REPLACE FUNCTION aggregate_5m_to_1h_window(
  p_symbol text,
  p_from_utc timestamptz,
  p_to_utc timestamptz,
  p_derivation_version int DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cnt int;
  v_q int;
BEGIN
  -- Source 5m bars (still need UNION ALL since 5m is in derived_data_bars)
  WITH src AS (
    SELECT 
      ts_utc, open, high, low, close, vol, vwap, trade_count
    FROM data_bars
    WHERE canonical_symbol = p_symbol
      AND timeframe = '5m'
      AND ts_utc >= p_from_utc
      AND ts_utc < p_to_utc
    
    UNION ALL
    
    SELECT 
      ts_utc, open, high, low, close, vol, vwap, trade_count
    FROM derived_data_bars
    WHERE canonical_symbol = p_symbol
      AND timeframe = '5m'
      AND deleted_at IS NULL
      AND ts_utc >= p_from_utc
      AND ts_utc < p_to_utc
  ),
  
  agg AS (
    SELECT
      COUNT(*) as source_count,
      (ARRAY_AGG(open ORDER BY ts_utc))[1] as agg_open,
      MAX(high) as agg_high,
      MIN(low) as agg_low,
      (ARRAY_AGG(close ORDER BY ts_utc DESC))[1] as agg_close,
      SUM(vol) as agg_vol,
      NULL::decimal as agg_vwap,
      SUM(trade_count) as agg_trade_count
    FROM src
  )
  
  SELECT source_count INTO v_cnt FROM agg;
  
  -- Return early if no source data
  IF v_cnt = 0 THEN
    RETURN jsonb_build_object(
      'success', true,
      'stored', false,
      'reason', 'no_source_data',
      'source_count', 0
    );
  END IF;
  
  -- Quality score based on completeness (12 bars expected)
  IF v_cnt >= 12 THEN
    v_q := 2;  -- Excellent
  ELSIF v_cnt >= 8 THEN
    v_q := 1;  -- Good
  ELSE
    v_q := 0;  -- Poor
  END IF;
  
  -- Store if we have at least 8 bars
  IF v_cnt >= 8 THEN
    INSERT INTO derived_data_bars (
      canonical_symbol, timeframe, ts_utc,
      open, high, low, close,
      vol, vwap, trade_count,
      is_partial, source, ingested_at,
      source_timeframe, source_candles, expected_candles,
      quality_score, derivation_version, raw
    )
    SELECT
      p_symbol,
      '1h',
      p_from_utc,  -- Window start
      agg_open, agg_high, agg_low, agg_close,
      agg_vol, agg_vwap, agg_trade_count,
      (v_cnt < 12),  -- is_partial
      'agg',  -- source
      NOW(),
      '5m',  -- source_timeframe
      v_cnt,  -- source_candles
      12,  -- expected_candles
      v_q,  -- quality_score
      p_derivation_version,
      jsonb_build_object('kind', 'aggregation', 'method', '5m_to_1h')
    FROM agg
    ON CONFLICT (canonical_symbol, timeframe, ts_utc)
      WHERE (deleted_at IS NULL)
    DO UPDATE SET
      open = EXCLUDED.open,
      high = EXCLUDED.high,
      low = EXCLUDED.low,
      close = EXCLUDED.close,
      vol = EXCLUDED.vol,
      source_candles = EXCLUDED.source_candles,
      quality_score = EXCLUDED.quality_score,
      is_partial = EXCLUDED.is_partial,
      ingested_at = NOW();
    
    RETURN jsonb_build_object(
      'success', true,
      'stored', true,
      'source_count', v_cnt,
      'quality_score', v_q
    );
  ELSE
    RETURN jsonb_build_object(
      'success', true,
      'stored', false,
      'reason', 'insufficient_source_bars',
      'source_count', v_cnt
    );
  END IF;
END;
$$;

-- ============================================================================
-- Update catchup_aggregation_range to use updated source query
-- ============================================================================

-- This function already calls aggregate_1m_to_5m_window and aggregate_5m_to_1h_window,
-- but it also has a direct UNION ALL query for checking max source timestamp.
-- We need to update that query to remove UNION ALL for 1m.

CREATE OR REPLACE FUNCTION catchup_aggregation_range(
  p_symbol text,
  p_to_tf text,
  p_start_cursor_utc timestamptz,
  p_max_windows integer DEFAULT 100,
  p_now_utc timestamptz DEFAULT NULL,
  p_derivation_version int DEFAULT 1,
  p_ignore_confirmation boolean DEFAULT false
)
RETURNS jsonb 
LANGUAGE plpgsql 
SECURITY DEFINER 
SET search_path=public 
AS $$
DECLARE
  v_now timestamptz := coalesce(p_now_utc, now());
  v_interval_min int; 
  v_delay_sec int;
  v_cursor timestamptz := p_start_cursor_utc;
  v_ws timestamptz; 
  v_we timestamptz; 
  v_confirm timestamptz;
  v_processed int := 0; 
  v_created int := 0; 
  v_poor int := 0; 
  v_skipped int := 0;
  v_res jsonb; 
  v_stored boolean; 
  v_source_rows int;
  v_q int;
  v_max_source_ts timestamptz;
  v_src_tf text;
BEGIN
  -- CRITICAL: Guard against NULL cursor (bootstrap failure or bypass)
  IF p_start_cursor_utc IS NULL THEN
    RAISE EXCEPTION 
      'catchup_aggregation_range: start cursor is NULL for %/%',
      p_symbol, p_to_tf;
  END IF;
  
  -- Get aggregation config and source timeframe
  SELECT run_interval_minutes, aggregation_delay_seconds, source_timeframe 
  INTO v_interval_min, v_delay_sec, v_src_tf
  FROM data_agg_state 
  WHERE canonical_symbol = p_symbol AND timeframe = p_to_tf;

  IF v_interval_min IS NULL THEN 
    RAISE EXCEPTION 'Missing agg config %/%', p_symbol, p_to_tf; 
  END IF;

  -- Safety check: get max available source timestamp
  -- Updated to only query appropriate table based on source timeframe
  IF v_src_tf = '1m' THEN
    -- For 1m source, only query data_bars (DXY now included there)
    SELECT MAX(ts_utc) INTO v_max_source_ts
    FROM data_bars
    WHERE canonical_symbol = p_symbol AND timeframe = v_src_tf;
  ELSE
    -- For 5m+ source, use UNION ALL (data still in derived_data_bars)
    SELECT MAX(ts_utc) INTO v_max_source_ts
    FROM (
      SELECT ts_utc FROM data_bars 
        WHERE canonical_symbol = p_symbol AND timeframe = v_src_tf
      UNION ALL
      SELECT ts_utc FROM derived_data_bars 
        WHERE canonical_symbol = p_symbol AND timeframe = v_src_tf AND deleted_at IS NULL
    ) x;
  END IF;
  
  -- If cursor is already beyond available data, return immediately
  IF v_max_source_ts IS NOT NULL AND v_cursor > v_max_source_ts THEN
    RETURN jsonb_build_object(
      'success', true,
      'windows_processed', 0,
      'cursor_advanced_to', v_cursor,
      'bars_created', 0,
      'bars_quality_poor', 0,
      'bars_skipped', 0,
      'continue', false,
      'reason', 'cursor_beyond_source_data'
    );
  END IF;

  -- Process windows up to max_windows limit
  WHILE v_processed < p_max_windows LOOP
    v_ws := v_cursor;
    v_we := v_ws + make_interval(mins => v_interval_min);
    v_confirm := v_we + make_interval(secs => v_delay_sec);

    -- Stop if we haven't reached confirmation time (unless ignoring)
    IF (NOT p_ignore_confirmation) AND v_now < v_confirm THEN 
      EXIT; 
    END IF;

    -- Aggregate the window
    IF p_to_tf = '5m' THEN
      v_res := aggregate_1m_to_5m_window(p_symbol, v_ws, v_we, p_derivation_version);
    ELSIF p_to_tf = '1h' THEN
      v_res := aggregate_5m_to_1h_window(p_symbol, v_ws, v_we, p_derivation_version);
    ELSE
      RAISE EXCEPTION 'Unsupported tf=%', p_to_tf;
    END IF;

    -- Extract results with contract validation
    v_stored := coalesce((v_res->>'stored')::boolean, false);
    v_source_rows := NULLIF((v_res->>'source_count')::int, NULL);
    
    -- DEFENSIVE: Validate window function returned source_count
    IF v_source_rows IS NULL THEN
      RAISE EXCEPTION
        'aggregate window returned no source_count for %/% window [%,%): response=%',
        p_symbol, p_to_tf, v_ws, v_we, v_res;
    END IF;
    
    -- CRITICAL FIX: EXIT only when source_rows = 0 (data frontier reached)
    IF v_source_rows = 0 THEN
      v_skipped := v_skipped + 1;
      EXIT;  -- Stop at data frontier
    END IF;
    
    -- Update counters based on whether bar was stored
    IF v_stored THEN
      v_created := v_created + 1;
      v_q := (v_res->>'quality_score')::int;
      IF v_q <= 0 THEN 
        v_poor := v_poor + 1; 
      END IF;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;
    
    -- CRITICAL FIX: Advance cursor when we processed a window with source data
    v_cursor := v_we;
    v_processed := v_processed + 1;
    
    -- INVARIANT: Cursor must never move backwards
    IF v_cursor < p_start_cursor_utc THEN
      RAISE EXCEPTION 
        'Cursor moved backwards: % < % for %/%',
        v_cursor, p_start_cursor_utc, p_symbol, p_to_tf;
    END IF;
  END LOOP;

  -- Return results
  RETURN jsonb_build_object(
    'success', true,
    'windows_processed', v_processed,
    'cursor_advanced_to', v_cursor,
    'bars_created', v_created,
    'bars_quality_poor', v_poor,
    'bars_skipped', v_skipped,
    'continue', (v_processed >= p_max_windows)
  );
END;
$$;

COMMIT;

-- Verification queries
DO $$
BEGIN
  RAISE NOTICE 'Migration complete: Aggregation functions updated';
  RAISE NOTICE 'Changes:';
  RAISE NOTICE '  - aggregate_1m_to_5m_window: Removed UNION ALL (reads only from data_bars)';
  RAISE NOTICE '  - aggregate_5m_to_1h_window: Kept UNION ALL (5m still in derived_data_bars)';
  RAISE NOTICE '  - catchup_aggregation_range: Smart source query based on timeframe';
  RAISE NOTICE '';
  RAISE NOTICE 'Next step: Test aggregation with: SELECT aggregate_1m_to_5m_window(''DXY'', NOW() - INTERVAL ''5 minutes'', NOW(), 1);';
END $$;
