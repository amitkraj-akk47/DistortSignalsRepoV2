-- Fix aggregator cursor management bug
-- Prevents cursor from advancing beyond available source data
-- 
-- Root cause: catchup_aggregation_range was advancing cursor even when source_count=0
-- Fix: Only advance cursor when source_count > 0, exit when source_count = 0 (data frontier)
--
-- Critical semantic: cursor advancement means "window processed" not "bar created"
-- This allows idempotent windows (stored=false, source_count>0) to advance correctly

BEGIN;

-- Drop and recreate catchup_aggregation_range with fix
DROP FUNCTION IF EXISTS catchup_aggregation_range(text,text,timestamptz,integer,timestamptz,int,boolean);

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
  -- This prevents processing when cursor is already beyond available data
  SELECT max(ts_utc) INTO v_max_source_ts
  FROM (
    SELECT ts_utc FROM data_bars 
      WHERE canonical_symbol = p_symbol AND timeframe = v_src_tf
    UNION ALL
    SELECT ts_utc FROM derived_data_bars 
      WHERE canonical_symbol = p_symbol AND timeframe = v_src_tf AND deleted_at IS NULL
  ) x;
  
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
    -- Do NOT exit merely because stored=false (could be quality skip, idempotent, etc.)
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
    -- (regardless of whether we stored a bar - handles idempotent case correctly)
    v_cursor := v_we;
    v_processed := v_processed + 1;
    
    -- INVARIANT: Cursor must never move backwards
    IF v_cursor < p_start_cursor_utc THEN
      RAISE EXCEPTION 
        'Cursor moved backwards: % < % for %/%',
        v_cursor, p_start_cursor_utc, p_symbol, p_to_tf;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'windows_processed', v_processed,
    'cursor_advanced_to', v_cursor,
    'bars_created', v_created,
    'bars_quality_poor', v_poor,
    'bars_skipped', v_skipped,
    'continue', (v_processed = p_max_windows),
    'max_source_ts', v_max_source_ts
  );
END $$;

-- Restore permissions (secure by default - service_role only)
REVOKE EXECUTE ON FUNCTION catchup_aggregation_range(text,text,timestamptz,integer,timestamptz,int,boolean) FROM public;
REVOKE EXECUTE ON FUNCTION catchup_aggregation_range(text,text,timestamptz,integer,timestamptz,int,boolean) FROM anon;
REVOKE EXECUTE ON FUNCTION catchup_aggregation_range(text,text,timestamptz,integer,timestamptz,int,boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION catchup_aggregation_range(text,text,timestamptz,integer,timestamptz,int,boolean) TO service_role;

COMMIT;
