-- Post-Deployment Verification Queries
-- Run these after deploying the worker with automatic orphan detection

-- 1. Check if orphaned records have been marked
SELECT 
    canonical_symbol,
    timeframe,
    status,
    notes,
    updated_at
FROM data_ingest_state
WHERE status = 'orphaned'
ORDER BY updated_at DESC;

-- Expected: 3 records (AUDNZD, BTC, XAGUSD) with status='orphaned'

-- 2. Check all state records and their status
SELECT 
    status,
    COUNT(*) as count
FROM data_ingest_state
GROUP BY status
ORDER BY count DESC;

-- Expected: 'ok' or 'running' for active assets, 'orphaned' for 3 disabled ones

-- 3. Check recent job runs
SELECT 
    id,
    job_name,
    status,
    created_at,
    finished_at,
    rows_written,
    metadata->>'subrequests' as subrequests,
    error_message
FROM ops_job_runs
WHERE job_name LIKE '%tick_factory%'
ORDER BY created_at DESC
LIMIT 5;

-- Expected: status='completed', no error_message

-- 4. Verify no more exceededCpu errors (check Cloudflare logs)
-- Look for these in Cloudflare dashboard logs:
--   ✅ "ORPHAN_SCAN_START"
--   ✅ "ORPHAN_DETECTED: Found 3 orphaned state records"
--   ✅ "ORPHAN_MARKED" (3 times)
--   ✅ "JOB_RUN_COMPLETED"
--   ❌ No "exceededCpu" errors

-- 5. Optional: Clean up orphaned records after verification
-- DELETE FROM data_ingest_state WHERE status = 'orphaned';
