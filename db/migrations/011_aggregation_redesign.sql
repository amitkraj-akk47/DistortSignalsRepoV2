-- ============================================================================
-- PHASE 5: AGGREGATION SYSTEM REDESIGN
-- 
-- Purpose:
--   1. Unified agg_start_utc across all assets (2025-07-01 00:00:00+00)
--   2. Remove UNION ALL from bootstrap and catchup (use conditional source table logic)
--   3. Enforce agg_start_utc guard in window processing
--   4. Distinguish mandatory tasks (hard_failed) from optional (disabled) on failure
--   5. Add task_priority for scheduling flexibility
--   6. Add enabled flag for task control
--
-- Key Design Decisions:
--   - agg_start_utc = deterministic boundary-aligned timestamp (not data-dependent)
--   - bootstrap cursor = aligned window start (independent of latest data)
--   - catchup frontier = source_count=0 immediately stops processing
--   - mandatory tasks never auto-disable (status=hard_failed instead)
--   - data_bars = 1m only; derived_data_bars = 5m+ only (no UNION ALL)
--
-- ============================================================================

BEGIN;

-- 1) Add Phase 5 columns to data_agg_state
-- =========================================
ALTER TABLE data_agg_state
  ADD COLUMN IF NOT EXISTS agg_start_utc timestamptz NOT NULL DEFAULT '2025-07-01 00:00:00+00',
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS task_priority integer NOT NULL DEFAULT 100;

-- 2) Set unified start date for all existing rows
-- ===============================================
UPDATE data_agg_state
SET agg_start_utc = '2025-07-01 00:00:00+00'
WHERE agg_start_utc IS DISTINCT FROM '2025-07-01 00:00:00+00';

-- 3) Index for task selection (is_mandatory, timeframe, priority, last_successful_at)
-- ====================================================================================
CREATE INDEX IF NOT EXISTS idx_agg_state_due_priority
  ON data_agg_state (is_mandatory DESC, timeframe ASC, task_priority ASC, last_successful_at_utc ASC NULLS FIRST)
  WHERE status='idle' AND enabled=true;

-- 4) DROP old function signatures (if upgrading; safe if not present)
-- ===================================================================
DROP FUNCTION IF EXISTS agg_bootstrap_cursor(text, text, timestamptz) CASCADE;
DROP FUNCTION IF EXISTS catchup_aggregation_range(text, text, timestamptz, integer, timestamptz, integer, boolean) CASCADE;
DROP FUNCTION IF EXISTS agg_finish(text, text, boolean, timestamptz, jsonb, text, text) CASCADE;
DROP FUNCTION IF EXISTS agg_get_due_tasks(text, timestamptz, integer, integer) CASCADE;
DROP FUNCTION IF EXISTS sync_agg_state_from_registry() CASCADE;

-- 5) agg_bootstrap_cursor - Deterministic start (no data dependency, no UNION ALL)
-- =================================================================================
CREATE OR REPLACE FUNCTION agg_bootstrap_cursor(
  p_symbol text,
  p_to_tf text,
  p_now_utc timestamptz DEFAULT now()
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_interval_min int;
  v_src_tf text;
  v_start timestamptz;
  v_start_ms bigint;
  v_interval_ms bigint;
  v_boundary_ms bigint;
BEGIN
  SELECT run_interval_minutes, source_timeframe, agg_start_utc
    INTO v_interval_min, v_src_tf, v_start
  FROM data_agg_state
  WHERE canonical_symbol = p_symbol AND timeframe = p_to_tf;

  IF v_interval_min IS NULL OR v_src_tf IS NULL THEN
    RAISE EXCEPTION 'Missing config in data_agg_state for %/%', p_symbol, p_to_tf;
  END IF;

  -- Unified start date across all assets
  IF v_start IS NULL THEN
    v_start := '2025-07-01 00:00:00+00'::timestamptz;
  END IF;

  -- Align start to the interval boundary (defensive)
  v_interval_ms := v_interval_min::bigint * 60000;
  v_start_ms := floor(extract(epoch from v_start) * 1000)::bigint;
  v_boundary_ms := (v_start_ms / v_interval_ms) * v_interval_ms;

  -- Cursor contract: "start timestamp of the NEXT window to process"
  -- Return the boundary itself as the first window start.
  RETURN to_timestamp(v_boundary_ms / 1000.0)::timestamptz;
END;
$$;

REVOKE EXECUTE ON FUNCTION agg_bootstrap_cursor(text, text, timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION agg_bootstrap_cursor(text, text, timestamptz) TO service_role;

-- 6) catchup_aggregation_range - Process windows with agg_start guard, no UNION ALL
-- ===================================================================================
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
SET search_path = public
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
  v_agg_start_utc timestamptz;

  v_last_window_start_possible timestamptz;
BEGIN
  IF p_start_cursor_utc IS NULL THEN
    RAISE EXCEPTION 'catchup_aggregation_range: start cursor is NULL for %/%', p_symbol, p_to_tf;
  END IF;

  SELECT run_interval_minutes, aggregation_delay_seconds, source_timeframe, agg_start_utc
    INTO v_interval_min, v_delay_sec, v_src_tf, v_agg_start_utc
  FROM data_agg_state
  WHERE canonical_symbol = p_symbol AND timeframe = p_to_tf;

  IF v_interval_min IS NULL THEN
    RAISE EXCEPTION 'Missing agg config %/%', p_symbol, p_to_tf;
  END IF;

  IF v_agg_start_utc IS NULL THEN
    v_agg_start_utc := '2025-07-01 00:00:00+00'::timestamptz;
  END IF;

  -- Enforce unified start date for all assets/timeframes
  IF v_cursor < v_agg_start_utc THEN
    v_cursor := v_agg_start_utc;
  END IF;

  -- Max source timestamp (NO UNION ALL - conditional table selection)
  IF v_src_tf = '1m' THEN
    SELECT MAX(ts_utc) INTO v_max_source_ts
    FROM data_bars
    WHERE canonical_symbol = p_symbol AND timeframe = v_src_tf;
  ELSE
    SELECT MAX(ts_utc) INTO v_max_source_ts
    FROM derived_data_bars
    WHERE canonical_symbol = p_symbol
      AND timeframe = v_src_tf
      AND deleted_at IS NULL;
  END IF;

  -- Early exit if no source data at all
  IF v_max_source_ts IS NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'windows_processed', 0,
      'cursor_advanced_to', v_cursor,
      'bars_created', 0,
      'bars_quality_poor', 0,
      'bars_skipped', 0,
      'continue', false,
      'reason', 'no_source_data_anywhere'
    );
  END IF;

  -- With cursor-as-next-window-start:
  -- last window start we could possibly process is the window that contains v_max_source_ts,
  -- i.e. floor(v_max_source_ts to interval boundary).
  v_last_window_start_possible :=
    to_timestamp(
      (floor(extract(epoch from v_max_source_ts) * 1000)::bigint / (v_interval_min::bigint * 60000)) * (v_interval_min::bigint * 60000)
      / 1000.0
    )::timestamptz;

  IF v_cursor > v_last_window_start_possible THEN
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

  WHILE v_processed < p_max_windows LOOP
    v_ws := v_cursor;
    v_we := v_ws + make_interval(mins => v_interval_min);
    v_confirm := v_we + make_interval(secs => v_delay_sec);

    -- Guard: skip anything before agg_start_utc (extra safety)
    IF v_ws < v_agg_start_utc THEN
      v_cursor := v_we;
      v_processed := v_processed + 1;
      CONTINUE;
    END IF;

    IF (NOT p_ignore_confirmation) AND v_now < v_confirm THEN
      EXIT;
    END IF;

    IF p_to_tf = '5m' THEN
      v_res := aggregate_1m_to_5m_window(p_symbol, v_ws, v_we, p_derivation_version);
    ELSIF p_to_tf = '1h' THEN
      v_res := aggregate_5m_to_1h_window(p_symbol, v_ws, v_we, p_derivation_version);
    ELSE
      RAISE EXCEPTION 'Unsupported tf=%', p_to_tf;
    END IF;

    v_stored := coalesce((v_res->>'stored')::boolean, false);
    v_source_rows := NULLIF((v_res->>'source_count')::int, NULL);

    IF v_source_rows IS NULL THEN
      RAISE EXCEPTION
        'aggregate window returned no source_count for %/% window [%,%): response=%',
        p_symbol, p_to_tf, v_ws, v_we, v_res;
    END IF;

    -- Frontier rule: stop immediately when source_count=0
    IF v_source_rows = 0 THEN
      v_skipped := v_skipped + 1;
      EXIT;
    END IF;

    IF v_stored THEN
      v_created := v_created + 1;
      v_q := (v_res->>'quality_score')::int;
      IF v_q <= 0 THEN v_poor := v_poor + 1; END IF;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;

    v_cursor := v_we;
    v_processed := v_processed + 1;

    IF v_cursor < p_start_cursor_utc THEN
      RAISE EXCEPTION 'Cursor moved backwards: % < % for %/%',
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
    'continue', (v_processed >= p_max_windows),
    'agg_start_enforced', v_agg_start_utc
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION catchup_aggregation_range(text, text, timestamptz, integer, timestamptz, integer, boolean) FROM public;
GRANT EXECUTE ON FUNCTION catchup_aggregation_range(text, text, timestamptz, integer, timestamptz, integer, boolean) TO service_role;

-- 7) agg_finish - Distinguish mandatory (hard_failed) from optional (disabled) on hard failure
-- ============================================================================================
CREATE OR REPLACE FUNCTION agg_finish(
  p_symbol text,
  p_tf text,
  p_success boolean,
  p_new_cursor_utc timestamptz DEFAULT null,
  p_stats jsonb DEFAULT null,
  p_fail_kind text DEFAULT null,
  p_error text DEFAULT null,
  p_now_utc timestamptz DEFAULT now(),
  p_auto_disable_hard_fail_threshold int DEFAULT 3
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next_run timestamptz;
  v_err text;
  v_bars_created int := coalesce((p_stats->>'bars_created')::int, 0);
  v_bars_poor int := coalesce((p_stats->>'bars_quality_poor')::int, 0);

  v_status text;
  v_streak int;
  v_is_mandatory boolean;
BEGIN
  SELECT
    p_now_utc + make_interval(mins => run_interval_minutes),
    is_mandatory
  INTO v_next_run, v_is_mandatory
  FROM data_agg_state
  WHERE canonical_symbol = p_symbol AND timeframe = p_tf;

  v_err := coalesce(p_error, 'unknown');
  IF length(v_err) > 1900 THEN v_err := left(v_err, 1900) || '... [truncated]'; END IF;

  IF p_success THEN
    UPDATE data_agg_state
    SET status = 'idle',
        running_started_at_utc = null,
        last_successful_at_utc = p_now_utc,
        last_error = null,
        hard_fail_streak = 0,
        last_agg_bar_ts_utc = coalesce(p_new_cursor_utc, last_agg_bar_ts_utc),
        next_run_at = v_next_run,
        total_runs = total_runs + 1,
        total_bars_created = total_bars_created + v_bars_created,
        total_bars_quality_poor = total_bars_quality_poor + v_bars_poor,
        updated_at = now()
    WHERE canonical_symbol = p_symbol AND timeframe = p_tf;

    RETURN jsonb_build_object('success', true);
  END IF;

  IF coalesce(p_fail_kind, 'hard') = 'transient' THEN
    UPDATE data_agg_state
    SET status = 'idle',
        running_started_at_utc = null,
        last_error = v_err,
        next_run_at = v_next_run,
        total_runs = total_runs + 1,
        updated_at = now()
    WHERE canonical_symbol = p_symbol AND timeframe = p_tf;

    RETURN jsonb_build_object('success', true, 'failed', true, 'kind', 'transient');
  END IF;

  UPDATE data_agg_state
  SET hard_fail_streak = coalesce(hard_fail_streak, 0) + 1,
      last_error = v_err,
      status =
        CASE
          WHEN (coalesce(hard_fail_streak, 0) + 1) >= p_auto_disable_hard_fail_threshold THEN
            CASE WHEN coalesce(v_is_mandatory, false) THEN 'hard_failed' ELSE 'disabled' END
          ELSE 'idle'
        END,
      running_started_at_utc = null,
      next_run_at = v_next_run,
      total_runs = total_runs + 1,
      updated_at = now()
  WHERE canonical_symbol = p_symbol AND timeframe = p_tf
  RETURNING status, hard_fail_streak INTO v_status, v_streak;

  RETURN jsonb_build_object(
    'success', true, 'failed', true, 'kind', 'hard',
    'status', v_status, 'hard_fail_streak', v_streak,
    'is_mandatory', coalesce(v_is_mandatory, false)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION agg_finish(text, text, boolean, timestamptz, jsonb, text, text, timestamptz, int) FROM public;
GRANT EXECUTE ON FUNCTION agg_finish(text, text, boolean, timestamptz, jsonb, text, text, timestamptz, int) TO service_role;

-- 8) agg_get_due_tasks - Updated with task_priority and enabled gate
-- ==================================================================
CREATE OR REPLACE FUNCTION agg_get_due_tasks(
  p_env_name text,
  p_now_utc timestamptz DEFAULT now(),
  p_limit int DEFAULT 20,
  p_running_stale_seconds int DEFAULT 900
)
RETURNS TABLE (
  canonical_symbol text,
  timeframe text,
  source_timeframe text,
  run_interval_minutes int,
  aggregation_delay_seconds int,
  last_agg_bar_ts_utc timestamptz,
  status text,
  hard_fail_streak int,
  task_priority int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Recover stale running tasks
  UPDATE data_agg_state
  SET status = 'idle',
      running_started_at_utc = null,
      last_error = left(coalesce(last_error, '') || ' | stale_running_recovered', 2000),
      updated_at = now()
  WHERE data_agg_state.status = 'running'
    AND running_started_at_utc IS NOT NULL
    AND running_started_at_utc < (p_now_utc - make_interval(secs => p_running_stale_seconds));

  RETURN QUERY
  SELECT s.canonical_symbol, s.timeframe, s.source_timeframe, s.run_interval_minutes,
         s.aggregation_delay_seconds, s.last_agg_bar_ts_utc, s.status, s.hard_fail_streak,
         s.task_priority
  FROM data_agg_state s
  JOIN core_asset_registry_all a ON a.canonical_symbol = s.canonical_symbol
  WHERE s.enabled = true
    AND s.status = 'idle'
    AND coalesce(s.next_run_at, p_now_utc) <= p_now_utc
    AND (
      (upper(p_env_name) IN ('DEV', 'TEST') AND a.test_active = true)
      OR
      (upper(p_env_name) NOT IN ('DEV', 'TEST') AND a.active = true)
    )
  ORDER BY s.is_mandatory DESC, s.timeframe ASC, s.task_priority ASC, s.last_successful_at_utc ASC NULLS FIRST
  LIMIT p_limit;
END $$;

REVOKE EXECUTE ON FUNCTION agg_get_due_tasks(text, timestamptz, int, int) FROM public;
GRANT EXECUTE ON FUNCTION agg_get_due_tasks(text, timestamptz, int, int) TO service_role;

-- 9) sync_agg_state_from_registry - Ensure tasks exist for all active assets
-- ===========================================================================
CREATE OR REPLACE FUNCTION sync_agg_state_from_registry(
  p_env_name text DEFAULT 'prod',
  p_agg_start_utc timestamptz DEFAULT '2025-07-01 00:00:00+00'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_created int := 0;
  v_updated int := 0;
  v_disabled int := 0;
BEGIN
  -- Upsert tasks for active assets (5m and 1h)
  WITH active_assets AS (
    SELECT DISTINCT
      car.canonical_symbol,
      tf.timeframe
    FROM core_asset_registry_all car
    CROSS JOIN (VALUES ('5m'::text), ('1h'::text)) tf(timeframe)
    WHERE (
      (upper(p_env_name) IN ('DEV', 'TEST') AND car.test_active = true)
      OR
      (upper(p_env_name) NOT IN ('DEV', 'TEST') AND car.active = true)
    )
  ),
  upsert_result AS (
    INSERT INTO data_agg_state (
      canonical_symbol,
      timeframe,
      source_timeframe,
      run_interval_minutes,
      aggregation_delay_seconds,
      is_mandatory,
      enabled,
      agg_start_utc,
      task_priority
    )
    SELECT
      aa.canonical_symbol,
      aa.timeframe,
      '1m'::text,
      CASE WHEN aa.timeframe = '5m' THEN 5 ELSE 60 END,
      30,
      true,
      true,
      p_agg_start_utc,
      100
    FROM active_assets aa
    ON CONFLICT (canonical_symbol, timeframe)
    DO UPDATE SET
      enabled = true,
      agg_start_utc = EXCLUDED.agg_start_utc,
      source_timeframe = EXCLUDED.source_timeframe,
      run_interval_minutes = EXCLUDED.run_interval_minutes,
      aggregation_delay_seconds = EXCLUDED.aggregation_delay_seconds,
      is_mandatory = true,
      updated_at = now()
    RETURNING xmax = 0 AS was_inserted
  )
  SELECT COUNT(*) INTO v_created FROM upsert_result WHERE was_inserted;

  SELECT COUNT(*) INTO v_updated FROM upsert_result WHERE NOT was_inserted;

  -- Disable tasks for inactive assets
  UPDATE data_agg_state das
  SET enabled = false, updated_at = now()
  WHERE NOT EXISTS (
    SELECT 1
    FROM core_asset_registry_all car
    WHERE car.canonical_symbol = das.canonical_symbol
      AND (
        (upper(p_env_name) IN ('DEV', 'TEST') AND car.test_active = true)
        OR
        (upper(p_env_name) NOT IN ('DEV', 'TEST') AND car.active = true)
      )
  )
  AND das.enabled = true;

  GET DIAGNOSTICS v_disabled = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'tasks_created', v_created,
    'tasks_updated', v_updated,
    'tasks_disabled', v_disabled,
    'timestamp_utc', now(),
    'env', p_env_name,
    'agg_start_utc', p_agg_start_utc
  );
END $$;

REVOKE EXECUTE ON FUNCTION sync_agg_state_from_registry(text, timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION sync_agg_state_from_registry(text, timestamptz) TO service_role;

-- 10) Final verification and initialization
-- ==========================================
-- Ensure all tasks are synced from registry on first deploy
SELECT sync_agg_state_from_registry('prod', '2025-07-01 00:00:00+00');

-- Log summary
DO $$ 
DECLARE
  v_total_tasks int;
  v_enabled_tasks int;
  v_hard_failed_tasks int;
BEGIN
  SELECT COUNT(*) INTO v_total_tasks FROM data_agg_state;
  SELECT COUNT(*) INTO v_enabled_tasks FROM data_agg_state WHERE enabled = true;
  SELECT COUNT(*) INTO v_hard_failed_tasks FROM data_agg_state WHERE status = 'hard_failed';
  
  RAISE NOTICE 'Phase 5 Migration Complete: % total tasks, % enabled, % hard_failed',
    v_total_tasks, v_enabled_tasks, v_hard_failed_tasks;
END $$;

COMMIT;
