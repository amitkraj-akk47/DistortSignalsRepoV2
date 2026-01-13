-- ============================================================================
-- PHASE 5 ROLLBACK SCRIPT
-- Use if 011_aggregation_redesign.sql deployment fails
-- 
-- This script safely removes all Phase 5 changes while preserving data
-- ============================================================================

BEGIN;

-- 1) Drop new indices
DROP INDEX IF EXISTS idx_agg_state_due_priority CASCADE;

-- 2) Drop new functions (Phase 5 additions)
DROP FUNCTION IF EXISTS sync_agg_state_from_registry(text, timestamptz) CASCADE;

-- 3) Drop function upgrades (restore old signatures if needed via separate rollback file)
-- For now, we just remove the Phase 5 versions
DROP FUNCTION IF EXISTS agg_bootstrap_cursor(text, text, timestamptz) CASCADE;
DROP FUNCTION IF EXISTS catchup_aggregation_range(text, text, timestamptz, integer, timestamptz, integer, boolean) CASCADE;
DROP FUNCTION IF EXISTS agg_finish(text, text, boolean, timestamptz, jsonb, text, text, timestamptz, int) CASCADE;
DROP FUNCTION IF EXISTS agg_get_due_tasks(text, timestamptz, integer, integer) CASCADE;

-- 4) Remove Phase 5 columns
ALTER TABLE data_agg_state
  DROP COLUMN IF EXISTS agg_start_utc CASCADE,
  DROP COLUMN IF EXISTS enabled CASCADE,
  DROP COLUMN IF EXISTS task_priority CASCADE;

-- 5) Reset any stuck running tasks to idle (safety)
UPDATE data_agg_state
SET status = 'idle',
    running_started_at_utc = null,
    last_error = 'rollback_applied'
WHERE status = 'running';

-- 6) Verify state
DO $$
DECLARE
  v_total_tasks int;
  v_col_count int;
BEGIN
  SELECT COUNT(*) INTO v_total_tasks FROM data_agg_state;
  SELECT COUNT(*) INTO v_col_count FROM information_schema.columns
    WHERE table_name = 'data_agg_state' 
      AND column_name IN ('agg_start_utc', 'enabled', 'task_priority');
  
  IF v_col_count > 0 THEN
    RAISE EXCEPTION 'Rollback incomplete: Phase 5 columns still exist (%)', v_col_count;
  END IF;
  
  RAISE NOTICE 'Phase 5 rollback complete: % tasks present, Phase 5 columns removed',
    v_total_tasks;
END $$;

COMMIT;

-- NOTE: To restore old functions after rollback, you will need to:
-- 1. Re-run the previous migration that created them (e.g., 010_*) OR
-- 2. Manually restore from a backed-up version
-- 
-- For safety, keep a backup of your current production functions before running migration 011.
