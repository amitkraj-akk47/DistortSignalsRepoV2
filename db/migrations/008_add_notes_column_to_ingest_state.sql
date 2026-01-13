-- Add notes column to data_ingest_state for tracking orphaned records
-- Date: 2026-01-13

BEGIN;

-- Add notes column if it doesn't exist
ALTER TABLE data_ingest_state
ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT NULL;

-- Add comment to table explaining the column
COMMENT ON COLUMN data_ingest_state.notes IS 'Internal notes about the record state, e.g., ORPHAN RECORD markers for disabled assets';

COMMIT;
