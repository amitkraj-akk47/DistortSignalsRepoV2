-- Migration 009: Add pause_fetch flag to data_ingest_state
-- Purpose: Allow pausing/resuming data fetching for individual assets without disabling them
-- When pause_fetch=true, the worker skips API data fetch but keeps state management active

ALTER TABLE data_ingest_state 
ADD COLUMN IF NOT EXISTS pause_fetch BOOLEAN NOT NULL DEFAULT false;

-- Add index for efficient filtering during worker runs
CREATE INDEX IF NOT EXISTS idx_data_ingest_state_pause_fetch 
ON data_ingest_state(pause_fetch) 
WHERE pause_fetch = true;

-- Add comment for documentation
COMMENT ON COLUMN data_ingest_state.pause_fetch IS 
'When true, worker skips API data fetch from Massive for this asset. Set to false to resume fetching.';
